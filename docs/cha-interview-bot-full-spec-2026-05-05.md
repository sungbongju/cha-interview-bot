# 차의과학대 면담봇 — 전체 기능·DB·인프라 종합 명세 (2026-05-05 시점)

> 이 문서는 cha-interview-bot 프로젝트의 **모든 기능, 데이터베이스, 인프라, 학과 연동, 피드백 반영 이력**을 한 문서에 모아둔 종합 명세서입니다.
> 작성일 기준 운영본은 [https://cha-interview-bot.vercel.app/](https://cha-interview-bot.vercel.app/) 이고 master 브랜치 최신 commit `abc1fb7` (또는 그 이후) 입니다.

---

## 1. 프로젝트 개요

| 항목 | 값 |
|---|---|
| 이름 | 차의과학대학교 미래융합대학 신입생 전공상담 AI 면담봇 |
| 목적 | 신입생·예비입학생이 11개 전공을 둘러보고 진로·학과 선택 상담을 자연어로 받을 수 있게 하는 인터랙티브 상담 봇 |
| 주력 학과 | 박대근 교수(경영학) — 면담봇 페르소나의 정체성. 다만 RAG·시스템 프롬프트 모두 11 전공 전반을 커버 |
| 배포 | Vercel (cha-interview-bot.vercel.app) + 학교 서버(aiforalab.com) + 미들턴 서버(middleton.p-e.kr) |
| 성격 | 음성·영상 아바타 + 텍스트 채팅 멀티 모드. RAG 기반 답변 + LLM 자연어 합성 |
| 11 전공 | 세포·유전자재생의학 / 시스템생명과학 / 바이오식의약학 / 디지털보건의료 / 스포츠의학 / 경영학 / 미디어커뮤니케이션학 / 심리학 / AI의료데이터학 / 미술치료 / 소프트웨어융합 |

---

## 2. 시스템 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│                        BROWSER (사용자 PC/모바일)                   │
│  React SPA — App.jsx, ChatPanel, AvatarPanel, AuthModal,         │
│  SurveyModal, ContactCard                                        │
│  HeyGen WebRTC SDK (LiveKit) — 아바타 비디오/오디오 스트리밍       │
└────────────┬────────────────────────────────────┬────────────────┘
             │                                    │
             │ HTTPS                              │ WebRTC (LiveKit)
             │                                    │
┌────────────▼─────────────────┐    ┌─────────────▼────────────────┐
│   Vercel Serverless          │    │  HeyGen Streaming Avatar     │
│   (cha-interview-bot.vercel) │    │  - heygen-token, heygen-proxy│
│                              │    │  - LiveKit room              │
│  /api/chat                   │    └──────────────────────────────┘
│  /api/heygen-proxy           │
│  /api/heygen-token           │
│  /api/school-api  (raw body) │
└────────────┬─────────────────┘
             │
   ┌─────────┴────────────────────────────────────┐
   │                                              │
   │ HTTPS (chat: 미들턴 finbot)                   │ HTTPS (school-api: 학교 PHP)
   ▼                                              ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│   Middleton 서버 (p-e.kr:443)       │    │   학교 서버 aiforalab.com           │
│   - nginx (TLS, /finbot 매핑)        │    │   - Apache 2.4.6 + PHP 5.4.45      │
│   - finbot Express :9000           │    │   - /interview-api/api.php          │
│     • routes/interview-chat.js     │    │     • kakao_login                  │
│       (RAG retrieve + Gemma4 LLM)  │    │     • email_signup/login           │
│     • utils/cha-rag.js (캐시)       │    │     • verify (JWT)                 │
│   - Ollama :11436                  │    │     • save_chat                    │
│     • bge-m3 (임베딩)               │    │     • save_survey                  │
│     • gemma4 (LLM)                 │    │     • survey_summary               │
│   - data/cha_rag_chunks.json       │    │   - MySQL 8.0 (cha_interview_db)    │
│     (131 청크, dim 1024)            │    │     • users (16+)                  │
│   - pm2 finbot-server              │    │     • chat_logs (449+)             │
│                                    │    │     • survey_responses (1+)        │
└────────────────────────────────────┘    └────────────────────────────────────┘
```

### 2.1 흐름 — 사용자 발화 한 번

1. 브라우저: 마이크 → STT(LiveKit) 또는 텍스트 입력
2. `App.sendMessage()` → `fetch('/api/chat', { message, history })`
3. Vercel `api/chat.js` → `https://middleton.p-e.kr/finbot/api/interview-chat`
4. 미들턴 finbot:
   - `retrieve(message, 5, 0.25)` → bge-m3 임베딩 → 코사인 유사도 → top-5 chunks
   - `pickContactFromHits(hits, message)` → 학과 컨택 객체 (또는 null)
   - 시스템 프롬프트(역할 + RAG 컨텍스트 + 발음 규칙) 빌드
   - Ollama Gemma4 호출 → JSON 응답
   - 후처리 (발음 규칙, 컨택 sanitize, 끝 안내 자동 부착)
   - `{ reply, ttsReply, contact? }` 반환
5. Vercel `api/chat.js`의 `sanitizeResponse` (TTS에서 URL/전화/이메일 통째 제거)
6. 브라우저: `setMessages([..., { role: 'assistant', text: reply, contact }])`
7. ChatPanel 메시지 렌더 + ContactCard 카드
8. (음성/영상 모드면) `streaming.task` HeyGen → 아바타 발화 (`ttsReply`)

### 2.2 사용자 — 채팅 저장 및 익명 정책

- 토큰 있으면 `chat_logs.user_id` 매핑
- 토큰 없으면 익명 — `user_id=NULL`, `session_id`만 보존
- 메시지 단위 저장 (사용자/어시스턴트 한 줄씩)

---

## 3. 사용자 기능 (UI)

### 3.1 모드

| 모드 | 코드 | 설명 |
|---|---|---|
| **FTF** (Face-to-Face) | `ftf` | 영상 + 음성 — 아바타 비디오 + 음성 발화 + STT |
| **STS** (Speech-to-Speech) | `sts` | 음성만 — 아바타 비디오 끄고 음성·STT |
| **TTT** (Text-to-Text) | `ttt` | 텍스트 채팅만 — STT/TTS 없이 키보드 입력 |

모드 전환은 [src/components/AvatarPanel.jsx](src/components/AvatarPanel.jsx) 상단 카드에서. 사용한 모드는 `App.modesUsedRef`에 누적되어 설문 조건부 문항 활성화 판정에 사용.

### 3.2 인증

- **카카오 로그인** — KAKAO_JS_KEY로 인가 → 학교 PHP `kakao_login` → JWT 발급 → localStorage 저장
- **이메일 가입/로그인** — `email_signup` / `email_login` (bcrypt 해시 + JWT)
- **익명 둘러보기** — 토큰 없이 모든 기능 사용 가능 (단 채팅 로그 user_id NULL)
- **방문 횟수** — `users.visit_count` 자동 증가, 한국 서수 인사("두번째 방문을 환영합니다")
- **첫 진입** — 자동 [src/components/AuthModal.jsx](src/components/AuthModal.jsx) 열림 (저장된 토큰 있으면 안 띄움)

### 3.3 채팅창 ([src/components/ChatPanel.jsx](src/components/ChatPanel.jsx))

- **헤더**: 좌측 "💬 면담 대화", 우측 [설문] 버튼 + 사용자명/[로그아웃] 또는 [로그인]
- **메시지 영역**: 사용자(우측 골드) / 어시스턴트(좌측 아바타+회색) 말풍선
- **타이핑 인디케이터**: 답변 생성 중 dot 애니메이션
- **입력창**: textarea (자동 높이) + 마이크 토글(◉/■) + 전송 버튼(↑)
- **하단 힌트**: "Enter로 전송 · Shift+Enter 줄바꿈"
- **컨택 카드**: 학과 안내 답변 시 어시스턴트 말풍선 아래에 골드 톤 카드(전화번호 tel:, 홈페이지 외부링크, 이메일 mailto:)

### 3.4 설문 모달 ([src/components/SurveyModal.jsx](src/components/SurveyModal.jsx))

- 트리거: (a) 헤더 "설문" 버튼 / (b) 종료 버튼 + 사용자 턴 ≥ 3 자동
- 4 섹션: Part I 인구통계(Q1-Q5) / Part II 18문항 4-Layer Yes/No / Part III Q24 / Part IV 자유응답(선택)
- 조건부 문항: Q14·Q22 (voice), Q16 (video), Q21 (revisit), Q23 (kakao UA) — 미충족 시 자동 disable + NULL 저장
- 진행 표시: `응답 N/M` (M은 활성 문항 수에 따라 동적)
- 옵트아웃: 우상단 "건너뛰기"

### 3.5 끝 안내 카드 (학과 컨택)

학과 관련 질문에 대한 답변 본문에는 전화번호·URL을 직접 적지 않고, 본문 끝에 "**학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요.**" 한 줄로 마무리. 컨택 정보는 별도 카드로:
- 전화번호 → `tel:` 링크 (모바일 탭 시 전화 앱)
- 홈페이지 → `target="_blank"` (새 탭)
- 학과장 이메일 → `mailto:`

---

## 4. 데이터베이스 (`cha_interview_db` @ aiforalab.com)

### 4.1 `users`

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INT AUTO_INCREMENT PK | |
| `kakao_id` | VARCHAR(64) UNIQUE | 카카오 사용자 ID |
| `email` | VARCHAR(255) UNIQUE | 이메일 가입 |
| `password_hash` | VARCHAR(255) | bcrypt (`$2y$10$...`) |
| `name` | VARCHAR(100) NOT NULL | |
| `visit_count` | INT DEFAULT 1 | 방문 횟수 |
| `last_login` | DATETIME | |
| `created_at` | DATETIME DEFAULT NOW | |

현재 16명 (카카오 12 + 이메일 4) 등록.

### 4.2 `chat_logs`

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INT AUTO_INCREMENT PK | |
| `user_id` | INT NULL | FK users.id ON DELETE SET NULL |
| `session_id` | VARCHAR(64) NOT NULL | `sess_<timestamp>_<rand>` |
| `role` | ENUM('user','assistant') | |
| `message` | TEXT NOT NULL | |
| `rag_hits` | TEXT | JSON encoded matched chunks (현재 모두 NULL — 미들턴 응답에 메타 미포함) |
| `created_at` | DATETIME DEFAULT NOW | |

INDEX: `(user_id)`, `(session_id)`, `(created_at)`.
현재 449줄 (사용자 메시지 ~150 + 어시스턴트 응답 ~250 + 익명 53).

### 4.3 `survey_responses` (v1, 39 컬럼)

```sql
CREATE TABLE survey_responses (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT DEFAULT NULL,                             -- FK users
  session_id      VARCHAR(64) DEFAULT NULL,                     -- chat_logs와 join 가능
  survey_version  VARCHAR(16) DEFAULT 'v1',

  -- Part I 인구통계 (Q1-Q5)
  grade           ENUM('1','2','3','4','etc'),
  gender          ENUM('female','male','no_answer'),
  mbti            CHAR(4),                                      -- 정규식 /^[EI][SN][TF][JP]$/
  major1          VARCHAR(32),                                  -- 11 전공 + 'none'
  major2          VARCHAR(32),

  -- Part II 18문항 Yes/No (조건 미충족 시 NULL)
  q06_digital_twin       TINYINT(1),                            -- L1 봇의 정체성
  q07_institution_id     TINYINT(1),                            -- L1
  q08_ai_disclosure      TINYINT(1),                            -- L1
  q09_rag_grounding      TINYINT(1),                            -- L2 답변의 품질
  q10_limit_admit        TINYINT(1),                            -- L2
  q11_warm_tone          TINYINT(1),                            -- L2
  q12_format_consistency TINYINT(1),                            -- L2
  q13_latency_pacing     TINYINT(1),                            -- L3 대화의 자연스러움
  q14_echo_guard         TINYINT(1),                            -- L3 (음성/영상만)
  q15_esc_interrupt      TINYINT(1),                            -- L3
  q16_avatar_embodiment  TINYINT(1),                            -- L3 (영상만)
  q17_mode_switch        TINYINT(1),                            -- L3
  q18_consent_ui         TINYINT(1),                            -- L4 정책과 관계 신호
  q19_guest_browse       TINYINT(1),                            -- L4
  q20_korean_ordinal     TINYINT(1),                            -- L4
  q21_visit_tracking     TINYINT(1),                            -- L4 (재방문만)
  q22_tts_normalize      TINYINT(1),                            -- L4 (음성/영상만)
  q23_kakao_redirect     TINYINT(1),                            -- L4 (카카오 UA만)

  -- Part III 전반 신뢰
  q24_overall_trust      TINYINT(1),

  -- 4-Layer 합산 점수 (서버 자동 계산)
  layer1_score    TINYINT,                                       -- 0-3 (Q6-Q8)
  layer2_score    TINYINT,                                       -- 0-4 (Q9-Q12)
  layer3_score    TINYINT,                                       -- 0-5 (Q13-Q17)
  layer4_score    TINYINT,                                       -- 0-6 (Q18-Q23)
  total_yes_count TINYINT,                                       -- 0-18

  -- Part IV 자유응답 (선택)
  free_positive   TEXT,                                          -- Q25
  free_negative   TEXT,                                          -- Q26

  -- 메타
  user_agent       VARCHAR(255),
  duration_seconds INT,
  flag_too_fast    TINYINT(1) DEFAULT 0,                         -- duration < 60 시 1
  submitted_at     DATETIME DEFAULT NOW,

  INDEX idx_user (user_id),
  INDEX idx_session (session_id),
  INDEX idx_version (survey_version),
  INDEX idx_submitted (submitted_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

서버측 4-Layer 자동 합산:
- L1 = Q6 + Q7 + Q8 (max 3)
- L2 = Q9 + Q10 + Q11 + Q12 (max 4)
- L3 = Q13 + Q14 + Q15 + Q16 + Q17 (max 5)
- L4 = Q18 + Q19 + Q20 + Q21 + Q22 + Q23 (max 6)
- total = 모든 Yes 합 (max 18)

NULL 응답(조건 미충족)은 합에서 제외.

---

## 5. PHP API (`server/api.php` @ /var/www/html/interview-api/)

### 5.1 라우팅

```
POST /interview-api/api.php?action=<액션>
```

| 액션 | 핸들러 | 권한 |
|---|---|---|
| `health` | inline | 누구나 |
| `kakao_login` | `handleKakaoLogin` | 누구나 (카카오 인가 토큰 검증) |
| `email_signup` | `handleEmailSignup` | 누구나 |
| `email_login` | `handleEmailLogin` | 누구나 |
| `verify` | `handleVerify` | JWT 보유자 |
| `save_chat` | `handleSaveChat` | 누구나 (익명 허용) |
| `list_chats` | `handleListChats` | JWT 보유자 (본인 로그만) |
| `save_survey` | `handleSaveSurvey` | 누구나 (익명 허용, 토큰 있으면 user_id 매핑) |
| `survey_summary` | `handleSurveySummary` | `X-Dashboard-Token` 헤더 (CHA_DASHBOARD_TOKEN env와 timing-safe 비교) |
| `usage_summary`  | `handleUsageSummary`  | 동일한 `X-Dashboard-Token` 게이트. **PII 노출 0** — 메시지 본문·이메일·kakao_id는 반환 안 함, 카운트와 메타만 |

### 5.2 환경변수 (`/var/www/html/interview-api/.htaccess` 의 `SetEnv`)

```
SetEnv CHA_DB_USER user2
SetEnv CHA_DB_PASS [REDACTED]
SetEnv CHA_JWT_SECRET [REDACTED — 64-hex JWT secret]
SetEnv CHA_DASHBOARD_TOKEN [REDACTED — 40-char dashboard token]
```

`/etc/httpd/conf.d/interview-api.conf`에서 `AllowOverride All`을 명시해야 `.htaccess`가 평가됨 (1.4절 참조).

### 5.3 JWT

- 알고리즘: HS256 (HMAC-SHA256, base64 직접 인코딩)
- 만료: 7일
- 페이로드: `{ user_id, exp }`
- 검증: `verifyJWT(token, secret)` — 서명 매치 + exp 체크

### 5.4 비밀번호 해시

PHP 5.4 호환을 위해 `password_hash` 대신 `crypt('$2y$10$...')` 직접 호출.

### 5.5 timing-safe compare

`hash_equals`가 PHP 5.6+이라 운영에서 사용 불가. inline XOR:

```php
$eq = false;
if (strlen($expected) === strlen($provided)) {
  $r = 0;
  for ($i = 0; $i < strlen($expected); $i++) {
    $r |= ord($expected[$i]) ^ ord($provided[$i]);
  }
  $eq = ($r === 0);
}
```

---

## 6. RAG 시스템 (미들턴 finbot)

### 6.1 운영 위치

| 항목 | 값 |
|---|---|
| HTTPS | `https://middleton.p-e.kr/finbot/api/interview-chat` |
| SSH | `ssh -p 7822 student04@middleton.p-e.kr` |
| 서버 경로 | `/home/student04/finbot/server/` |
| 프로세스 | pm2 `finbot-server` (Node v24.14.1 via nvm) |
| Express 포트 | 127.0.0.1:9000 (외부는 nginx → 9000) |
| Ollama | 127.0.0.1:11436 (`bge-m3` 임베딩, `gemma4:latest` LLM) |
| LLM 호출 | `http://127.0.0.1:11435/api/chat` (Gemma4) |

### 6.2 데이터 구조

- `data/cha_rag_chunks.json` — chunk 배열 (131개)
  ```json
  { "id": "ch-128", "section": "심리학",
    "question": "심리학 전공 학과 사무실에 어떻게 연락하면 되나요?",
    "answer": "심리학 전공 학과 사무실 연락처는 031-850-8939이에요. ...",
    "keywords": [...] }
  ```
- `data/cha_rag_embeddings.json` — 동일 길이의 정규화된 1024차원 벡터 배열

### 6.3 retrieve 알고리즘 (`utils/cha-rag.js`)

```js
async function retrieve(query, topK = 5, minScore = 0.25) {
  load();                                  // 모듈 캐시 — 첫 호출에서만 디스크 read
  const qvec = await embed(query);         // bge-m3 → 정규화
  const scored = _embeds.map((evec, i) => ({
    chunk: _chunks[i],
    score: dotProduct(qvec, evec)          // 정규화된 코사인 유사도
  }));
  return scored
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => ({ ...x.chunk, score: x.score }));
}
```

⚠️ **중요**: `_chunks`, `_embeds`는 모듈 로드 시 1회 캐시됨 → JSON 파일을 바꿔도 살아있는 Node 프로세스는 옛 데이터 그대로 → **`pm2 restart finbot-server`로 프로세스를 재시작해야 새 데이터 반영**.

### 6.4 chunk 분포 (현재 131)

#### 11 전공별 일반 chunk (ch-001~ch-120)

| section | 청크 수 |
|---|---|
| 경영학 (챕터 단위) | ~36 (1부 학과소개, 2부 Past, 3부 Present, 4부 진로트랙, 5부 학생, 6부 진로 + 단일 항목들) |
| 세포·유전자재생의학 | 11 |
| AI의료데이터학 | 9 |
| 스포츠의학 | 9 |
| 시스템생명과학 | 8 |
| 바이오식의약학 | 8 |
| 디지털보건의료 | 8 |
| 미디어커뮤니케이션학 | 8 |
| 심리학 | 8 |
| 미술치료 | 7 |
| 소프트웨어융합 | 7 |
| 오프닝/클로징/FAQ 등 | ~5 |

#### 학과 컨택 chunk (ch-121~ch-131)

11개 학과 — `section` 한국어 학과명, `answer`에 학과 사무실 전화 + 홈페이지 + (있는 경우) 학과장 이메일.

### 6.5 보강 도구 (`server/add_to_rag.js`)

```bash
node add_to_rag.js <new_chunks.jsonl>
```
- 기존 chunks/embeddings 백업 (`*.bak.<timestamp>`)
- 중복 ID 검사
- bge-m3로 임베딩 생성 (`embedding_text || question + ' ' + answer`)
- chunks.json + embeddings.json 갱신

---

## 7. 학과 페이지 연동

### 7.1 매핑 테이블 (`routes/interview-chat.js`의 `DEPT_CONTACTS`)

| 봇 전공명 (section) | dept (카드 표시) | phone | homepage | chairEmail | note |
|---|---|---|---|---|---|
| `세포·유전자재생의학` / `세포유전자재생의학` (alias) | 세포·유전자재생의학 전공 | 031-881-7140 | https://bm.cha.ac.kr/ | jsong@cha.ac.kr | — |
| `시스템생명과학` | 시스템생명과학 전공 | 031-881-7137 | https://fsb.cha.ac.kr/ | — | — |
| `바이오식의약학` | 바이오식의약학 전공 | 031-850-9320 | https://bio.cha.ac.kr/ | hongsr@cha.ac.kr | — |
| `디지털보건의료` | 디지털보건의료 전공 | 031-850-8940 | https://aihealthcare.cha.ac.kr/ | — | — |
| `스포츠의학` | 스포츠의학 전공 | 031-850-8941 | https://sports.cha.ac.kr/ | — | — |
| `경영학` | 경영학 전공 | 031-850-8944 | https://biz.cha.ac.kr/ | — | (학교 등록명: 데이터경영학과) |
| `미디어커뮤니케이션학` | 미디어커뮤니케이션학 전공 | 031-850-8945 | https://comm.cha.ac.kr/ | — | (학교 등록명: 의료홍보미디어학과) |
| `심리학` | 심리학 전공 | 031-850-8939 | https://cp.cha.ac.kr/ | — | (학교 등록명: 상담심리학과) |
| `AI의료데이터학` | AI의료데이터학 전공 | 031-850-8952 | https://dai.cha.ac.kr/ | — | 미래융합대학 학사지원실 |
| `미술치료` | 미술치료 전공 | 031-850-8943 | https://at.cha.ac.kr/ | — | — |
| `소프트웨어융합` | 소프트웨어융합 전공 | 031-850-8952 | https://swc.cha.ac.kr/ | — | 미래융합대학 학사지원실 |

### 7.2 학과 매칭 로직

`pickContactFromHits(hits, userMessage)`:
1. **userMessage 학과명 직접 매칭** (우선) — 키 길이 내림차순으로 검사 (긴 키가 짧은 키 안에 포함될 때 오매칭 방지). 변형: `sec`, `sec.replace('·', '')`, `sec + '과'`, `sec + '전공'`
2. **fallback** — RAG hits에 컨택 chunk(`ch-121~ch-131`)가 있으면 그 학과

자동 검증 결과 (cURL): 11/11 학과 정확 매핑 ✅

### 7.3 학과 페이지 출처

차의과학대 [통합 전화번호안내](https://www.cha.ac.kr/전화번호안내/) + 11개 학과 사이트의 교수진 페이지를 fetch해서 수집. 수집 결과 보고서: [docs/rag-contact-update-2026-05-05.md](docs/rag-contact-update-2026-05-05.md).

---

## 8. 발음 / TTS / HeyGen

### 8.1 시스템 프롬프트 룰 (LLM이 ttsReply 생성 시)

```
## TTS 발음 규칙 (ttsReply에만 적용, reply는 원형 유지)
- 영어 약어/고유명: CHA→차, AI→에이아이, IT→아이티, ESG→이에스지, RAG→랙,
  CPA→씨피에이, KAIST→카이스트, CEO→씨이오, R&D→알앤디, MBTI→엠비티아이
- 학교명: 차의과학대학교→차 의과학 대학교, 차병원→차 병원,
  미래융합대학→미래 융합 대학, 경영학전공→경영학 전공
- 11개 전공명 띄어쓰기:
  · 세포·유전자재생의학→세포 유전자 재생 의학
  · 시스템생명과학→시스템 생명 과학
  · 바이오식의약학→바이오 식의약학
  · 디지털보건의료→디지털 보건 의료
  · 스포츠의학→스포츠 의학
  · 미디어커뮤니케이션학→미디어 커뮤니케이션 학
  · 심리학→심리학(그대로)
  · AI의료데이터학→에이아이 의료 데이터학
  · 미술치료→미술 치료
  · 소프트웨어융합→소프트웨어 융합
  · 경영학→경영학(그대로)
- 기호: 가운뎃점(·)→띄어쓰기 한 칸, %→퍼센트, 숫자 + 가지/개/명 → 한글 수사로
```

### 8.2 후처리 안전망 (`routes/interview-chat.js`)

LLM이 룰 안 따를 때를 대비.

#### 컨택 정보 본문 통째 제거
- URL `https?://[^\s)\]]+` → 삭제
- `www.[^\s)\]]+` → 삭제
- `1899-XXXX` → 삭제
- `0XX-XXX(X)-XXXX` → 삭제
- 이메일 → 삭제
- 한글 발음형 (`[영일이삼사오육칠팔구공]\s*5+`) → 삭제

#### LLM이 만든 컨택 한 문장 통째 제거
- `[^.!?]*?(?:홈페이지는?|연락처는|사무실\s*번호[는을]?|이메일은)[^.!?]*?(?:입니다|이에요|예요|에요|이고|이며|이니|드려요|드릴게요|돼요)\.?` → 삭제

#### 한국어 조사 잔재 정리
- `는, ` `은, ` `이, ` `가, ` `을, ` `를, ` (조사 + 콤마) → 콤마만
- `이고, ` `이며, ` `이니, ` `이에요, ` `예요, ` 등 → 콤마만

#### 끝 안내문 통일 부착
- LLM이 자체 부착한 모든 변형 ("화면에 표시해 드릴게요/드려요/할게요/드립니다") 한 문장 단위로 제거
- `_contactObj` 있을 때만 통일 안내 한 번 부착: "학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요."

#### 발음 매핑 테이블 (8.1 룰의 안전망)

```js
const TTS_REPLACEMENTS = {
  '·': ' ',
  'CHA': '차', 'KAIST': '카이스트', 'CEO': '씨이오', 'CTO': '씨티오', 'CFO': '씨에프오',
  'CPA': '씨피에이', 'ESG': '이에스지', 'AI': '에이아이', 'IT': '아이티',
  'R&D': '알앤디', 'MBTI': '엠비티아이', 'RAG': '랙',
  '차의과학대학교': '차 의과학 대학교', '차병원': '차 병원',
  '미래융합대학': '미래 융합 대학', '경영학전공': '경영학 전공',
  '세포유전자재생의학': '세포 유전자 재생 의학',
  '시스템생명과학': '시스템 생명 과학',
  '바이오식의약학': '바이오 식의약학',
  '디지털보건의료': '디지털 보건 의료',
  'AI보건의료': '에이아이 보건 의료',
  '스포츠의학': '스포츠 의학',
  '미디어커뮤니케이션학': '미디어 커뮤니케이션 학',
  '미디어커뮤니케이션': '미디어 커뮤니케이션',
  'AI의료데이터학': '에이아이 의료 데이터학',
  'AI의료데이터': '에이아이 의료 데이터',
  '미술치료': '미술 치료',
  '소프트웨어융합': '소프트웨어 융합',
  '%': '퍼센트'
};
```

#### 숫자 + 가지/개 → 한글 수사
```js
.replace(/(\d)\s*가지/g, (m, n) => {
  const map = {'1':'한','2':'두','3':'세','4':'네','5':'다섯','6':'여섯','7':'일곱','8':'여덟','9':'아홉'};
  return (map[n] || n) + ' 가지';
})
```

### 8.3 Vercel 추가 sanitize (`api/chat.js`)

미들턴이 보낸 응답을 클라이언트로 forward 전 한 번 더 검증:

```js
ttsReply = ttsReply
  .replace(/https?:\/\/[^\s)\]]+/gi, '학과 홈페이지')
  .replace(/\b1899[-\s]?\d{4}\b/g, '학교 대표 번호')
  .replace(/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '학과 사무실')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '학과 이메일')
```

또 정성률 교수 피드백 반영:
```js
.replace(/신경\s*치료/g, '통증 관리')
```

### 8.4 HeyGen 자체

HeyGen은 단순 TTS 엔진 — 우리가 보낸 `ttsReply` 문자열을 그대로 음성 변환만 함. 자체 프롬프트·가공 없음. 따라서 **모든 발음 정밀화는 우리 백엔드(미들턴 + Vercel)에서 처리**.

---

## 9. 관리자 대시보드

### 9.1 URL & 토큰

🌐 https://cha-interview-bot.vercel.app/dashboard/

🔑 토큰: 환경변수 `CHA_DASHBOARD_TOKEN`. 페이지 첫 진입 시 prompt → sessionStorage 저장.

### 9.2 호스팅 구조

- 단일 정적 HTML — `public/dashboard/index.html`
- Vite 빌드 시 `public/`이 `dist/`로 복사 → Vercel이 `https://cha-interview-bot.vercel.app/dashboard/`로 서빙
- React 무관 (Vanilla HTML + Chart.js@4.4.4 CDN + Google Fonts)
- GitHub Pages로 옮길 경우: 별도 repo 또는 `docs/`로 이동 후 Pages 활성화. 현재는 Vercel에서 그대로 운영.

### 9.3 디자인 — 사이버 브루탈리즘

| 요소 | 처리 |
|---|---|
| 폰트 | JetBrains Mono (영문/숫자) + Pretendard (한글) — Google Fonts |
| 배경 | `#08090c` + 라임/시안 듀얼 라디얼 글로우 + 미세 스캔라인 |
| 카드 | 1px 헤어라인 + `4px 4px 0 #000` hard-edge 오프셋 그림자 + 직각 코너 + ┐ 마커 |
| KPI 좌측 액센트 바 | 라임 / 시안 / 마젠타 / 골드 |
| 헤더 | sticky — `● CHA / TRUST.SURVEY / DASHBOARD v1`, 라이브 펄스 + 노드명 + 갱신시각, `[ REFRESH ] [ TOKEN ]` |
| 차트 색 | L1 핫핑크 / L2 오렌지 / L3 라임 / L4 시안 / 전반 골드 |
| 마커 | `//`, `>>`, `[01]` 코드틱 |

### 9.4 표시 항목 (v2 — 두 섹션)

대시보드는 **두 개의 섹션**으로 구성. 페이지 로드 시 `usage_summary` + `survey_summary`를 `Promise.all`로 병렬 호출.

#### USAGE 섹션 (라임 좌측 바 / 사용 현황)

| 영역 | 내용 |
|---|---|
| **KPI 4개** | users_total (카카오/이메일 분해) / sessions_total (익명 세션·메시지 카운트) / messages_total (user/bot 분해) / avg_session_duration (평균 사용자 턴 수 포함) |
| DAILY ACTIVITY | 신규 가입 막대 + 활성 사용자 라인 + 세션 수 라인 (이중 축 한 차트에 3 시리즈) |
| SESSION TURN DISTRIBUTION | 사용자 턴 수 분포 — 1 / 2 / 3 / 4-5 / 6-10 / 11+ 막대 |
| HOURLY USAGE | 0-23시 사용자 발화 수 막대 |
| SIGNUP TYPE | 카카오 / 이메일 / 익명 세션 도넛 |
| REVISIT DISTRIBUTION | `users.visit_count` 분포 막대 |
| **TOP USERS** 표 | id / name / login_type 태그(kakao/email) / messages / user_msgs / sessions / visits / last_login. **이메일·kakao_id는 비공개** |

#### TRUST SURVEY 섹션 (시안 좌측 바 / 신뢰 설문)

| 영역 | 내용 |
|---|---|
| **KPI 4개** | total_responses / valid_responses(≥60s) / Q24 Yes율 / 평균 총점(0-18) |
| 18 컴포넌트별 Yes율 | 가로 막대, Layer 색 구분 |
| 4-Layer 평균 점수 | L1-L4 만점 대비 % |
| 일별 응답 추이 | 응답 수 막대 + 평균 점수 라인 (이중 축) |
| 인구통계 분포 | 학년·성별·1전공·MBTI 4표 |

### 9.4.1 PII 노출 정책

- **채팅 메시지 본문은 한 글자도 노출 안 함** — 카운트와 시각만
- **이메일·kakao_id 자체는 비공개** — 이름과 `login_type` 태그(kakao/email)까지만
- 자유응답(Q25/Q26) 텍스트도 `survey_summary`에서 반환 안 함
- 향후 운영자가 raw 채팅을 보려면 (a) 카카오/이메일 가입 동의서에 "운영진 익명 열람" 명시 + (b) admin 권한 시스템(`users.role`) + (c) audit log 구축이 선행되어야 함

### 9.5 데이터 흐름

```
[브라우저 대시보드]
   │ POST /api/school-api?action=survey_summary
   │ Header: X-Dashboard-Token: <secret>
   ▼
[Vercel api/school-api.js]
   │ (rawBody forward + X-Dashboard-Token forward)
   ▼
[학교 PHP api.php → handleSurveySummary]
   │ - X-Dashboard-Token vs CHA_DASHBOARD_TOKEN env (timing-safe XOR)
   │ - WHERE flag_too_fast=0 으로 유효 응답만
   │ - 18 컴포넌트별 yes-rate, 4-Layer 평균, 인구통계 분포, 일별 추이, 점수 히스토그램 집계
   │ - 개별 응답·자유응답 텍스트는 반환하지 않음 (개인정보 노출 차단)
   ▼ JSON
[브라우저 Chart.js 렌더]
```

### 9.6 차트 무한 확대 버그 fix

```css
.chart-wrap { position: relative; width: 100%; height: 280px; }
.chart-wrap.tall { height: 540px; }
```
```js
{ responsive: true, maintainAspectRatio: false, animation: false, resizeDelay: 120 }
```

---

## 10. 피드백 반영 이력 (시간순)

### 10.1 정성률 교수 — 스포츠의학 표현 (오전)

> "신경 치료 이후" 표현이 부적절하다.

반영:
- 기존 chunk `ch-052` 안의 `신경 치료 이후` → `회복 이후` / `통증 관리 이후`로 수정
- Vercel `api/chat.js`의 `sanitizeResponse`에 안전망 추가: `replace(/신경\s*치료/g, '통증 관리')`
- commit: `8d44447 fix: filter nerve treatment term from interview replies`

### 10.2 박대근 교수 — 전공별 RAG 보강 (오전)

> RAG가 11 전공 전부에 대해 풍부한가?

반영:
- 분석 결과: 경영학 외 9 전공이 4-6 chunk로 얇음
- 전공별 상세 chunk 38개 (`ch-083~ch-120`) 추가 — 자격증, 실습기관, 진로 트랙 등
- 세포·유전자재생의학 오타 fix: `활생학·신음 실습` → `발생학·생식의학 관련 실습`, `기업 단방` → `기업 탐방`
- 보고서: [docs/rag-analysis-report-2026-05-05.md](docs/rag-analysis-report-2026-05-05.md), [docs/rag-detailed-update-plan-2026-05-05.md](docs/rag-detailed-update-plan-2026-05-05.md)

### 10.3 박대근 교수 — 신뢰 컴포넌트 설문 (오후)

> 굳이 구글 폼으로 할 필요 없고, 우리 데이터베이스가 있으니 우리 것으로 해보자.

반영:
- `survey_responses` 테이블 v1 (39 컬럼) 신설
- PHP `handleSaveSurvey` + 4-Layer 자동 합산
- 프론트 `SurveyModal` (헤더 버튼 + 종료 자동 노출)
- 검증 후 테스트 데이터 정리 (id 1-3 삭제, id=4 실응답 보존)
- 보고서: [docs/internal-survey-implementation-2026-05-05.md](docs/internal-survey-implementation-2026-05-05.md), [docs/survey-design-2026-05-05.md](docs/survey-design-2026-05-05.md)

### 10.4 박대근 교수 — 대시보드 (오후)

> DB 잘 들어오는 것 확인. 한 눈에 볼 수 있게 대시보드 제작해 주면 좋겠다.

반영:
- 학교 PHP `handleSurveySummary` 신설 (X-Dashboard-Token 게이트, 집계만 반환)
- Vercel `api/school-api.js`가 `survey_summary` 액션 통과 + 헤더 forward
- 단일 HTML `public/dashboard/index.html` 작성 (Chart.js + 사이버 브루탈리즘)
- 차트 무한 확대 버그 수정 + 단순화 + 디자인 정립
- URL: https://cha-interview-bot.vercel.app/dashboard/

### 10.5 김종석 교수 — 카카오 로그인 시 동의 (오후)

> 카톡 로그인할 때 입력된 정보 사용에 대한 동의 등이 있어야 할 것 같다.

반영 계획 (후속):
- AuthModal에 동의 박스 1개 + "자세히" 펼침 (옵션 A)
- 동의 안 하면 카카오/이메일 버튼 disabled
- 처리방침 details 영역 또는 별도 페이지
- 옵션: `users.consent_version`, `consent_at` 컬럼 추가로 감사 대비

### 10.6 정호 학생 — 학과 직접 연락 안내 (저녁)

> "교수님께 직접 질문하라"고만 말하지 말고, 학과 사무실 번호·이메일·홈페이지를 같이 알려주면 좋겠다.

반영:
- 11개 학과 컨택 chunk (`ch-121~ch-131`) 미들턴 RAG에 추가 (120 → 131)
- DEPT_CONTACTS 매핑 11개 (시간순으로 deep search로 검증)
- 시스템 프롬프트 — 11 전공 일반화 + 컨택 정보 우선 안내 룰
- TTS 발음 규칙 정립 (cha-biz-ai-v8 표준 + 11 전공 확장)
- 컨택 카드 UI — 답변 본문에 전화/URL 안 적고 별도 카드로 표시 (`tel:` `mailto:` `target=_blank`)
- 끝 안내문 통일 — "학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요"
- 매핑 오류 fix (미술치료, 소프트웨어융합)
- 안내문 두 번 반복 fix
- 보고서: [docs/rag-contact-update-2026-05-05.md](docs/rag-contact-update-2026-05-05.md), [docs/development-log-2026-05-05.md](docs/development-log-2026-05-05.md)

### 10.7 정호 학생 — TTS 발화 자연스러움 (저녁)

> URL, 전화번호는 굳이 말로 안 해도 될 것 같다. 발음들이 좀 웃기다.

반영:
- 본문에서 컨택 정보 통째 제거 (reply + ttsReply 모두)
- ttsReply 끝에 자연어 한 줄 안내만
- LLM이 만든 한글 풀이 URL("에치티티에스피점차닷에이씨점케이알") 통째 제거
- 가운뎃점(·) → 공백 (음성에서 "점"으로 읽히는 것 차단)
- AI-BIZ-Page의 cha-biz-ai-v8에서 정립된 발음 표준 그대로 가져와 11 전공 확장 적용

---

## 11. 운영 자격증명 / 토큰 / 시크릿 (보안 메모)

### 11.1 노출된 자격증명 — 회전 권장

다음 값들이 본 문서·git history·로그에 평문 또는 부분 형태로 남음:

| 항목 | 값 | 권장 조치 |
|---|---|---|
| 학교 SSH user2 비밀번호 | `[REDACTED]` | 비번 변경 |
| 학교 DB user2 비밀번호 | `[REDACTED]` (SSH와 동일) | 별도 DB 사용자 분리 + 비번 변경 |
| 학교 JWT secret | `[REDACTED — 64-hex JWT secret]` | 회전 — `.htaccess` 한 줄 수정 + 모든 사용자 재로그인 필요 |
| 대시보드 토큰 | `[REDACTED — 40-char dashboard token]` | 회전 시 `.htaccess` 수정 + 대시보드 재입력 |
| 미들턴 SSH student04 비밀번호 | `[REDACTED]` | 비번 변경 + 가능하면 키 인증 전환 |

### 11.2 외부 API 키 (.env, git 미포함)

- `HEYGEN_API_KEY` — Vercel 환경변수
- `OPENAI_API_KEY` — Vercel 환경변수 (사용 안 하지만 등록됨)
- `MIDDLETON_API_URL=https://middleton.p-e.kr/finbot`
- `MIDDLETON_API_KEY` — Vercel 환경변수
- `KAKAO_JS_KEY` — Vercel 환경변수
- `ADMIN_PASSWORD` — Vercel 환경변수

### 11.3 학교 서버 보안 잡음

Apache `error_log`에 외부 자동 봇의 `.env`, `.htpasswd`, `xmlrpc.php`, `cgi-bin/.../bin/sh` 정찰 요청이 다수. 정상 노출 서버에서 흔한 패턴이지만, 위 자격증명 회전 우선순위를 올리는 근거.

---

## 12. 환경 변수 / 설정 파일

### 12.1 Vercel (`vercel.json`)

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/api/(.*)", "destination": "/api/$1" }]
}
```

Vercel 환경변수 (사용자 대시보드에서 설정):
- `HEYGEN_API_KEY`, `OPENAI_API_KEY`, `MIDDLETON_API_URL`, `MIDDLETON_API_KEY`
- `KAKAO_JS_KEY`, `ADMIN_PASSWORD`

### 12.2 학교 서버 (`/var/www/html/interview-api/.htaccess`)

```
SetEnv CHA_DB_USER user2
SetEnv CHA_DB_PASS [REDACTED]
SetEnv CHA_JWT_SECRET <64-hex>
SetEnv CHA_DASHBOARD_TOKEN <40-base64>
```

### 12.3 학교 서버 (`/etc/httpd/conf.d/interview-api.conf`)

```apache
<Directory "/var/www/html/interview-api">
    AllowOverride All
    Require all granted
</Directory>
```

### 12.4 미들턴 (`/home/student04/finbot/server/.env` — git 미포함)

```
EXAONE_MODEL=gemma4:latest
# 기타 finbot 내부 설정
```

---

## 13. 운영 인프라 종합

### 13.1 학교 서버 (aiforalab.com)

| 항목 | 값 |
|---|---|
| OS | CentOS 7 (kernel 3.10.0-1160) |
| Apache | 2.4.6 (Ubuntu nginx 아님 — CentOS httpd) |
| PHP | 5.4.45 |
| MySQL | 8.0 (cha_interview_db) |
| SSH 포트 | 10022 (user2 / NOPASSWD: ALL sudo) |
| HTTPS | Let's Encrypt 인증서 (`/etc/letsencrypt/live/aiforalab.com`) |

### 13.2 미들턴 서버 (middleton.p-e.kr)

| 항목 | 값 |
|---|---|
| OS | Ubuntu (host: cha-Bigdata) |
| nginx | 1.18.0 (TLS termination + reverse proxy) |
| Node | v24.14.1 (nvm) |
| PM2 | finbot-server 외 다수 서비스 |
| Ollama | port 11436 (bge-m3, gemma4) + 11435 (chat API) |
| 다른 서비스 | Open-WebUI :3000, JupyterHub :8000, RStudio :8787, MedGemma :8004 |
| SSH 포트 | 7822 (외부 22, 2022, 22022 등 차단) |

### 13.3 Vercel

| 항목 | 값 |
|---|---|
| 프로젝트 | cha-interview-bot |
| 빌드 | Vite (`npm run build` → `dist/`) |
| 자동 배포 | GitHub master push에서 트리거 |
| Bot Protection | 활성 — 외부 cURL 트래픽은 봇 챌린지 (브라우저 자동 통과) |
| 정적 호스팅 | `dist/dashboard/index.html` 그대로 서빙 |

---

## 14. 개발자용 핵심 명령

### 14.1 학교 서버에 PHP 배포

```bash
# 로컬에서:
pscp -P 10022 server/api.php user2@aiforalab.com:/tmp/api_v1.php

# SSH로:
ssh -p 10022 user2@aiforalab.com
cp /var/www/html/interview-api/api.php /var/www/html/interview-api/api.php.bak.$(date +%Y%m%d-%H%M%S)
cp /tmp/api_v1.php /var/www/html/interview-api/api.php
php -l /var/www/html/interview-api/api.php   # syntax check
```

### 14.2 학교 DB 마이그레이션

```bash
mysql -u user2 -p'[REDACTED]' cha_interview_db < migration.sql
```

### 14.3 미들턴 RAG 갱신

```bash
# 로컬에서:
pscp -P 7822 server/contact_chunks_*.jsonl student04@middleton.p-e.kr:/home/student04/finbot/server/contact_chunks.jsonl

# SSH로:
ssh -p 7822 student04@middleton.p-e.kr
cd /home/student04/finbot/server
export PATH=/home/student04/.nvm/versions/node/v24.14.1/bin:$PATH
node add_to_rag.js contact_chunks.jsonl     # 자동 백업 + 임베딩 + 추가
pm2 restart finbot-server                   # 메모리 캐시 무효화
```

### 14.4 미들턴 finbot 코드 수정

```bash
ssh -p 7822 student04@middleton.p-e.kr
cd /home/student04/finbot/server/routes
cp interview-chat.js interview-chat.js.bak.$(date +%Y%m%d-%H%M%S)
vi interview-chat.js
node --check interview-chat.js
pm2 restart finbot-server --update-env
pm2 logs finbot-server --lines 30 --nostream    # 로그 확인
```

### 14.5 운영 DB 검증

```sql
-- 응답 수
SELECT COUNT(*) FROM survey_responses WHERE flag_too_fast = 0;

-- 18 컴포넌트 yes-rate
SELECT
  ROUND(AVG(q06_digital_twin)*100,1) AS Q06,
  ROUND(AVG(q07_institution_id)*100,1) AS Q07,
  -- ... q24 까지
  ROUND(AVG(total_yes_count),2) AS avg_total
FROM survey_responses WHERE flag_too_fast=0;

-- 학과별
SELECT major1, COUNT(*) AS n, ROUND(AVG(total_yes_count),2) AS avg_score
FROM survey_responses WHERE flag_too_fast=0 GROUP BY major1;
```

---

## 15. 미해결 / 후속 작업

### 15.1 즉시 해야 할 것

1. **카카오 동의 UI** (김종석 교수 피드백) — AuthModal에 체크박스 + 처리방침 모달
2. **자격증명 회전** (11.1 표 참조)
3. **운영 카카오 로그인 실사용 검증** — 사용자가 실제 로그인 한 번 확인

### 15.2 분석/리포팅

4. **자유응답 Q25/Q26 분석** — 키워드 빈도, 주제 분류
5. **대시보드 추가 차트**:
   - Q24 ↔ 4-Layer 로지스틱 회귀
   - 컴포넌트 × Q24 카이제곱 (각 2x2 교차표)
   - 18 응답 패턴 클러스터링
   - 자유응답 워드클라우드
6. **CSV 내보내기 버튼** — 분석가가 R/Python으로 후속 분석 시 raw 또는 집계 다운로드

### 15.3 인프라

7. **미들턴 nginx `/finbot/` location 명시** — 외부 cURL 직접 호출 시 한글 깨짐 해결 (사용자 실 흐름엔 영향 없음)
8. **`chat_logs.rag_hits` 활성화** — 미들턴 응답에 `rag` 메타 추가하면 채팅별 매칭 chunk 분석 가능
9. **AI의료데이터학·소프트웨어융합 학과 직통 부여 시 chunk 갱신** — 학과 사무실에 문의해 직통 받으면 ch-129/ch-131 한 줄 갈아끼우기

### 15.4 RAG 보강 후속

10. 전공별 원본 전사본을 별도 원천자료로 보관
11. 모든 전공에 대해 영상 질문 단위로 chunk 더 세분화
12. 교수님별 검수 피드백을 받아 부정확한 표현 수정
13. 학생 실제 질문 로그 분석으로 빈번 질문 기준 RAG 보강

---

## 16. 변경 이력

- **2026-05-02** 프로젝트 초기. survey_responses (Likert v0) 초안.
- **2026-05-04** 카카오 로그인, 음성/영상 모드, RAG 82 청크 운영.
- **2026-05-05 오전** RAG 분석 + 38 청크 보강 (82 → 120). 신경 치료 표현 수정.
- **2026-05-05 11:48** 학교 api.php 새 버전 배포 (fallback 제거).
- **2026-05-05 13:00** 카카오 로그인 차단 발견 → AllowOverride None 진단 → conf 신설로 복구.
- **2026-05-05 14:30** 신뢰 컴포넌트 설문 v1 DB·API·UI 구축. session_id NULL fix.
- **2026-05-05 15:00** Vercel raw body forward (한글 인코딩 fix).
- **2026-05-05 15:30** 대시보드 백엔드 + 단일 HTML 출시.
- **2026-05-05 16:00** 대시보드 사이버 브루탈리즘 재디자인. 차트 무한 확대 fix.
- **2026-05-05 17:00** 미들턴 RAG 11개 학과 컨택 chunk 추가 (120 → 131).
- **2026-05-05 17:10** 시스템 프롬프트 11 전공 일반화 + TTS 발음 규칙 정립.
- **2026-05-05 17:30** 컨택 카드 UI (tel:/mailto:/외부링크) 도입. 매핑 오류 fix.
- **2026-05-05 17:45** 안내문 두 번 반복 fix. 11/11 학과 자동 검증 완료.
- **2026-05-05 18:00** 본 종합 명세 문서 v1 작성.
- **2026-05-05 18:20** 대시보드 v2 — USAGE 섹션 추가 (`usage_summary` 액션). 사용자/세션/메시지 집계, 일별 활성, 세션 턴 분포, 시간대 분포, 가입 종류 도넛, 재방문 분포, Top 10 사용자 표. PII 노출 0 정책 유지. commit `abc1fb7`.

---

## 17. 함께 보면 좋은 문서

- [docs/development-log-2026-05-05.md](docs/development-log-2026-05-05.md) — 오늘 작업의 단계별 자세한 로그
- [docs/internal-survey-implementation-2026-05-05.md](docs/internal-survey-implementation-2026-05-05.md) — 설문 구현 사양
- [docs/survey-design-2026-05-05.md](docs/survey-design-2026-05-05.md) — 교수님 보고용 설문 디자인
- [docs/rag-analysis-report-2026-05-05.md](docs/rag-analysis-report-2026-05-05.md) — RAG 1차 분석 (오전 작업)
- [docs/rag-detailed-update-plan-2026-05-05.md](docs/rag-detailed-update-plan-2026-05-05.md) — RAG 38 청크 보강 plan
- [docs/rag-contact-update-2026-05-05.md](docs/rag-contact-update-2026-05-05.md) — 학과 컨택 chunk 보강 가이드
- [docs/trust-ablation-google-form-draft-2026-05-05.md](docs/trust-ablation-google-form-draft-2026-05-05.md) — 신뢰 ablation 구글폼 초안 (대안)
- [docs/change-summary-2026-05-04.md](docs/change-summary-2026-05-04.md), [docs/merge-report-2026-05-04.md](docs/merge-report-2026-05-04.md) — 어제까지의 변경 요약
