# 자체 설문 구현 문서 - 2026-05-05 (v1)

## 1. 배경

박대근 교수님 피드백에 따라 신뢰설계 컴포넌트 설문은 구글폼이 아니라 현재 운영 중인 자체 데이터베이스에 저장한다.

> 설문 디자인을 해보자. 굳이 구글 폼으로 할 필요 없고, 우리 데이터베이스가 있으니 우리 것으로 해보자.

교수님이 작성하신 `survey-draft-v1.md`를 그대로 채택하여 구현한다. (Yes/No 18문항 + 인구통계 5 + 자유응답 2)

## 2. 구현 방향

- 상담 종료 시 사용자 턴이 **3회 이상**일 때만 자체 설문 모달을 표시한다.
- 응답은 학교 서버 DB의 `survey_responses` 테이블에 저장한다.
- 기존 로그인 토큰이 있으면 `user_id`와 연결한다 (없으면 익명).
- 현재 상담 세션이 있으면 `session_id`와 연결한다.
- 18개 신뢰설계 컴포넌트 + 전체 신뢰 1문항(Q24)은 Yes/No.
- 4-layer 합산 점수(L1: 0-3, L2: 0-4, L3: 0-5, L4: 0-6, total: 0-18)는 서버에서 자동 계산해 저장한다.
- 조건부 문항은 사용 모드/방문 횟수/접속 경로에 따라 자동 비활성화 + NULL 저장:
  - Q14, Q22 — 음성/영상 모드 사용자만
  - Q16 — 영상(FTF) 모드 사용자만
  - Q21 — 재방문자(visit_count >= 2)만
  - Q23 — 카카오톡 UA 진입자만
- 자유응답(Q25, Q26)은 선택 입력.
- 60초 미만 제출은 `flag_too_fast=1`로 마킹 (저질 응답 필터링용).

## 3. DB 테이블

테이블명: `survey_responses` (`server/schema.sql`)

주요 필드:

| 필드 | 타입 | 비고 |
|---|---|---|
| `user_id` | INT NULL | users 테이블 FK (익명 NULL) |
| `session_id` | VARCHAR(64) | chat_logs와 조인 가능 |
| `survey_version` | VARCHAR(16) | 'v1' 고정 |
| `grade` | ENUM('1','2','3','4','etc') | Q1 |
| `gender` | ENUM('female','male','no_answer') | Q2 |
| `mbti` | CHAR(4) NULL | Q3, 정규식 검증 후 저장 |
| `major1`, `major2` | VARCHAR(32) | Q4, Q5 (`major2='none'` 가능) |
| `q06_*` ~ `q23_*` | TINYINT(1) NULL | Q6~Q23 Yes(1)/No(0)/N/A(NULL) |
| `q24_overall_trust` | TINYINT(1) NULL | Q24 Yes/No |
| `layer1_score` ~ `layer4_score` | TINYINT | 서버 자동 합산 |
| `total_yes_count` | TINYINT | 0-18 |
| `free_positive`, `free_negative` | TEXT NULL | Q25, Q26 |
| `user_agent`, `duration_seconds`, `flag_too_fast` | 메타 |
| `submitted_at` | DATETIME | 제출 시각 |

## 4. 추가 API

학교 PHP API (`server/api.php`)에 `save_survey` 액션 추가.

요청 예시:

```json
{
  "action": "save_survey",
  "token": "(선택) 로그인 토큰",
  "session_id": "sess_1762...",
  "survey_version": "v1",
  "grade": "1",
  "gender": "female",
  "mbti": "INFJ",
  "major1": "경영학",
  "major2": "none",
  "q06_digital_twin": 1,
  "q07_institution_id": 1,
  "q08_ai_disclosure": 0,
  "q09_rag_grounding": 1,
  "q10_limit_admit": 1,
  "q11_warm_tone": 1,
  "q12_format_consistency": 0,
  "q13_latency_pacing": 1,
  "q14_echo_guard": null,
  "q15_esc_interrupt": 1,
  "q16_avatar_embodiment": null,
  "q17_mode_switch": 1,
  "q18_consent_ui": 1,
  "q19_guest_browse": 0,
  "q20_korean_ordinal": 1,
  "q21_visit_tracking": null,
  "q22_tts_normalize": null,
  "q23_kakao_redirect": null,
  "q24_overall_trust": 1,
  "free_positive": "전공별 구체적인 답변이 좋았습니다.",
  "free_negative": "",
  "duration_seconds": 215
}
```

응답 예시:

```json
{
  "success": true,
  "id": 1,
  "layer_scores": { "L1": 2, "L2": 3, "L3": 3, "L4": 2, "total": 10 }
}
```

## 5. 프론트 구현

추가 파일:

- `src/lib/trustComponents.js` — 18문항 메타데이터 (Q6~Q23 + Q24 + 전공/MBTI 리스트)
- `src/components/SurveyModal.jsx` — 단일 모달 UI
- `src/components/SurveyModal.module.css` — 스타일

수정 파일:

- `src/lib/api.js` — `saveSurvey()` 클라이언트 추가
- `api/school-api.js` — allowlist에 `save_survey` 추가
- `src/App.jsx` — `stopAvatar()`에서 사용자 턴 3회 이상일 때 `SurveyModal` 노출
- `src/App.jsx` — `userTurnCountRef`, `modesUsedRef`로 트리거 조건 추적

UI 동작:

- 진행 표시: "응답 N/M" (M은 활성 문항 수에 따라 동적)
- Yes/No는 가로 토글 버튼 (모바일 친화)
- 조건부 문항은 자동 비활성화 + "해당 없음" 표시
- 인구통계 + 18문항 + Q24 모두 응답해야 제출 활성
- 자유응답은 선택 (비어있어도 제출 가능)
- "건너뛰기" 텍스트 링크 제공

## 6. 운영 서버 반영 필요 작업

이 워크트리는 코드 사본이므로, 운영 학교 API 서버(aiforalab.com)에는 다음 작업이 필요하다.

1. **DB 마이그레이션**

   ```sql
   USE cha_interview_db;
   -- server/schema.sql의 survey_responses 블록 실행
   ```

2. **PHP API 배포**

   `/var/www/html/interview-api/api.php`에 다음을 반영:
   - `switch ($action)` 블록에 `case 'save_survey':` 추가
   - 파일 끝에 `handleSaveSurvey()` 함수 추가

3. **Vercel 배포**

   `api/school-api.js`의 ALLOWED_ACTIONS에 `save_survey`가 포함된 상태로 main에 머지 → 자동 배포.

4. **저장 검증**

   ```bash
   curl -X POST 'https://cha-interview-bot.vercel.app/api/school-api?action=save_survey' \
     -H 'Content-Type: application/json' \
     -d '{
       "session_id":"test_sess_001","survey_version":"v1",
       "grade":"1","gender":"female","mbti":"INFJ","major1":"경영학","major2":"none",
       "q06_digital_twin":1,"q07_institution_id":1,"q08_ai_disclosure":1,
       "q09_rag_grounding":1,"q10_limit_admit":1,"q11_warm_tone":1,"q12_format_consistency":1,
       "q13_latency_pacing":1,"q15_esc_interrupt":1,"q17_mode_switch":1,
       "q18_consent_ui":1,"q19_guest_browse":1,"q20_korean_ordinal":1,
       "q24_overall_trust":1,
       "duration_seconds":180
     }'
   ```

   기대 응답:
   ```json
   { "success": true, "id": 1, "layer_scores": { "L1":3,"L2":4,"L3":3,"L4":3,"total":13 } }
   ```

   DB 확인:
   ```sql
   SELECT id, session_id, total_yes_count, layer1_score, layer2_score, layer3_score, layer4_score, submitted_at
     FROM survey_responses ORDER BY id DESC LIMIT 5;
   ```

## 7. 분석 가능 지표

DB 저장 후 다음 분석이 가능하다.

- Q24 전반 신뢰 Yes 비율 + 95% CI
- 18 컴포넌트별 Yes 비율 + 신뢰구간
- 4-layer 점수 분포 + 평균
- 4-layer score → 전반 신뢰(Q24) 로지스틱 회귀
- 컴포넌트 × Q24 카이제곱 검정 (각 2x2 교차표)
- 18개 응답 패턴 클러스터링
- 인구통계(학년/성별/MBTI/전공)별 컴포넌트 신뢰도 차이
- 사용 모드 × 컴포넌트 효과 (chat_logs 조인)
- 채팅 로그 길이/턴 수 × 신뢰도 상관

## 8. 부록 A — 문항-컴포넌트 매핑

| 문항 | 컴포넌트 # | 컴포넌트 이름 | Layer | DB 컬럼 |
|------|---|---|---|---|
| Q6  | 01 | 박대근 교수 풀 디지털 트윈 | L1 | q06_digital_twin |
| Q7  | 02 | 기관 신원 표시 | L1 | q07_institution_id |
| Q8  | 03 | AI 정체 명시 | L1 | q08_ai_disclosure |
| Q9  | 04 | RAG 사실성 | L2 | q09_rag_grounding |
| Q10 | 05 | 한계의 명시적 인정 | L2 | q10_limit_admit |
| Q11 | 06 | 해요체와 따뜻한 말투 | L2 | q11_warm_tone |
| Q12 | 07 | 출력 형식 강제 | L2 | q12_format_consistency |
| Q13 | 08 | 응답 레이턴시 관리 | L3 | q13_latency_pacing |
| Q14 | 09 | Echo guard 다층 방어 | L3 | q14_echo_guard |
| Q15 | 10 | ESC 발화 인터럽트 | L3 | q15_esc_interrupt |
| Q16 | 11 | 아바타 입동기·제스처 | L3 | q16_avatar_embodiment |
| Q17 | 12 | 모드 전환 부드러움 | L3 | q17_mode_switch |
| Q18 | 13 | 개인정보 동의 UI | L4 | q18_consent_ui |
| Q19 | 14 | 비로그인 둘러보기 옵션 | L4 | q19_guest_browse |
| Q20 | 15 | 한글 서수 인사말 | L4 | q20_korean_ordinal |
| Q21 | 16 | 방문 횟수 추적 | L4 | q21_visit_tracking |
| Q22 | 17 | TTS 발음 normalization | L4 | q22_tts_normalize |
| Q23 | 18 | 카카오 인앱 외부 전환 | L4 | q23_kakao_redirect |

## 9. 변경 이력

- v1 (2026-05-05): 교수님 `survey-draft-v1.md` 채택. Yes/No 18문항 + 인구통계 5 + 자유응답 2. 단일 모달, 사용자 턴 3회 이상일 때만 노출.
