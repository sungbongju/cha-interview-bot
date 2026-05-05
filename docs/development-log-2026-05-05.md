# 차의과학대 면담봇 — 대규모 개발 작업 로그 (2026-05-05)

> 작성: 2026-05-05
> 범위: 하루 동안 여러 단계로 진행된 운영 인프라 복구, 설문 시스템 구현, 관리자 대시보드, RAG 보강, TTS·HeyGen 발음 정립, 컨택 카드 UI 등 일련의 변경 전체 정리.

---

## 0. 한 줄 요약

운영 카카오 로그인 차단을 해결하고, 신뢰 컴포넌트 설문 v1을 자체 DB로 구축하고, 관리자 대시보드(사이버 브루탈리즘)를 GitHub-Pages-호환 단일 HTML로 만들고, 미들턴 RAG에 11개 학과 컨택 정보를 보강하고, HeyGen 발음 규칙을 표준화한 뒤, 학과 컨택을 본문에서 빼고 클릭 가능한 카드로 분리해 표시하는 구조로 정리했다.

---

## 1. 인프라 — 운영 카카오 로그인 복구

### 1.1 증상

오전 11:25까지는 정상이었던 학교 API가 갑자기 모든 액션에 다음을 반환:

```json
{"success":false,"error":"Server configuration error"}
```

증상 발생 시점: 11:48 학교 서버 `api.php` 교체 직후.

### 1.2 진단 (read-only)

운영 학교 서버(SSH `user2@aiforalab.com:10022`)에서 read-only 조회로 다음을 확인:

| 항목 | 결과 |
|---|---|
| `httpd.conf:124-125, 131-151` | `<Directory "/var/www">`, `<Directory "/var/www/html">` 모두 `AllowOverride None` |
| `/etc/httpd/conf.d/` | interview-api 전용 설정 파일 **없음** |
| `mod_env`, `mod_setenvif` | 모두 `(shared)` 정상 로드 |
| `/var/www/html/interview-api/.htaccess` | `SetEnv CHA_DB_USER user2`, `SetEnv CHA_DB_PASS [REDACTED]`, `SetEnv CHA_JWT_SECRET ...` 3줄 정상 |
| Apache `error_log` | `[interview-api] Missing env: CHA_DB_USER / CHA_DB_PASS / CHA_JWT_SECRET` 다수 |
| Apache 마지막 (re)start (`systemctl show httpd`) | `ActiveEnterTimestamp=2026-02-25 20:50:56 KST` |

직전 배포된 두 `api.php`의 결정적 차이:

```php
// api.php.bak.survey-20260505 (살아있던 버전)
$db_user    = getenv('CHA_DB_USER')    ?: 'user2';
$db_pass    = getenv('CHA_DB_PASS')    ?: '[REDACTED]';
$JWT_SECRET = getenv('CHA_JWT_SECRET') ?: 'b271c8857...';

// api.php (11:48 배포본)
$db_user    = getenv('CHA_DB_USER')    ?: '';
$db_pass    = getenv('CHA_DB_PASS')    ?: '';
$JWT_SECRET = getenv('CHA_JWT_SECRET') ?: '';
```

### 1.3 한 줄 진단

> **AllowOverride None × .htaccess SetEnv × fallback 제거의 3중 동시 발생.** 어느 하나만 없었어도 깨지지 않았을 결함. 11:48 새 api.php가 fallback 리터럴을 빈 문자열로 바꾸면서 그동안 숨어있던 "환경변수가 사실 한 번도 안 들어오고 있었다"는 진실이 드러난 것.

### 1.4 해결

`/etc/httpd/conf.d/interview-api.conf` 신설:

```apache
<Directory "/var/www/html/interview-api">
    AllowOverride All
    Require all granted
</Directory>
```

검증:

```bash
sudo /usr/sbin/httpd -t          # Syntax OK
sudo systemctl reload httpd      # reload OK

curl -sS -X POST 'http://localhost/interview-api/api.php?action=verify' \
  -H 'Content-Type: application/json' -d '{"token":"x"}'
# Before: {"success":false,"error":"Server configuration error"}
# After : {"success":false,"error":"invalid token"}   ← 환경변수 활성화 확인

curl -sS 'https://aiforalab.com/interview-api/api.php?action=health'
# {"status":"ok","service":"cha-interview-bot API"}
```

`"invalid token"`은 의도된 응답 — PDO 연결까지 성공하고 JWT 검증 단계까지 진행됐다는 뜻.

### 1.5 진행 중 사고 (자진 보고)

PowerShell→plink 따옴표 이스케이프가 깨져 conf 파일이 1차 시도에 잘못 들어갔고, 2차 base64 시도에서 `$B64`가 빈 문자열로 전달되어 결과적으로 운영 conf가 0바이트로 덮였다. 빈 파일이라 syntax/Apache 기능엔 영향 없었지만 위험한 동작이었다. 3차에 로컬에서 `[System.IO.File]::WriteAllText`로 LF·따옴표 보존된 파일을 만들고 `pscp`로 올린 뒤 `sudo cp` 한 게 지금 들어가 있는 정상본이다.

---

## 2. 신뢰 컴포넌트 설문 시스템 v1

박대근 교수 작성 `survey-draft-v1.md`를 기반으로 18개 신뢰설계 컴포넌트(Q6-Q23) + Q24 전반 신뢰 + 인구통계 5(Q1-Q5) + 자유응답 2(Q25-Q26) 구조의 자체 DB 설문을 구축.

### 2.1 DB 스키마 (`server/schema.sql`)

`cha_interview_db.survey_responses` 39 컬럼:

```sql
CREATE TABLE survey_responses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  session_id VARCHAR(64) DEFAULT NULL,
  survey_version VARCHAR(16) DEFAULT 'v1',
  -- 인구통계
  grade ENUM('1','2','3','4','etc'),
  gender ENUM('female','male','no_answer'),
  mbti CHAR(4),
  major1 VARCHAR(32), major2 VARCHAR(32),
  -- 18문항 Yes/No (조건부 미충족 시 NULL)
  q06_digital_twin TINYINT(1), q07_institution_id TINYINT(1), q08_ai_disclosure TINYINT(1),
  q09_rag_grounding TINYINT(1), q10_limit_admit TINYINT(1), q11_warm_tone TINYINT(1), q12_format_consistency TINYINT(1),
  q13_latency_pacing TINYINT(1), q14_echo_guard TINYINT(1), q15_esc_interrupt TINYINT(1), q16_avatar_embodiment TINYINT(1), q17_mode_switch TINYINT(1),
  q18_consent_ui TINYINT(1), q19_guest_browse TINYINT(1), q20_korean_ordinal TINYINT(1), q21_visit_tracking TINYINT(1), q22_tts_normalize TINYINT(1), q23_kakao_redirect TINYINT(1),
  q24_overall_trust TINYINT(1),
  -- 4-Layer 점수 (서버 자동 계산)
  layer1_score TINYINT, layer2_score TINYINT, layer3_score TINYINT, layer4_score TINYINT,
  total_yes_count TINYINT,
  -- Part IV 자유응답
  free_positive TEXT, free_negative TEXT,
  -- 메타
  user_agent VARCHAR(255), duration_seconds INT, flag_too_fast TINYINT(1) DEFAULT 0,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id), INDEX idx_session (session_id),
  INDEX idx_version (survey_version), INDEX idx_submitted (submitted_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 2.2 PHP API — `case 'save_survey'`

`server/api.php`에 `handleSaveSurvey()` 추가:
- Yes/No 정규화 (`toBool`): `1/'yes'/'Y'`/`true` → 1, `0/'no'/'N'`/`false` → 0, 미응답/`null` → NULL
- allowlist 검증: `grade`, `gender`, `major1/2`, `mbti` (정규식 `/^[EI][SN][TF][JP]$/`)
- 4-Layer 합산: L1=Q6-8, L2=Q9-12, L3=Q13-17, L4=Q18-23
- `flag_too_fast`: `duration_seconds < 60` → 1
- `user_agent` mb_substr(0,255)
- 자유응답 mb_substr(0,2000)
- 응답: `{success, id, layer_scores: {L1, L2, L3, L4, total}}`

### 2.3 프론트 ([src/components/SurveyModal.jsx](src/components/SurveyModal.jsx))

단일 모달, 4섹션:
1. **Part I 인구통계** — Q1 학년 / Q2 성별 / Q3 MBTI(선택) / Q4 1전공 / Q5 2전공
2. **Part II 18문항** Layer 1-4 그룹핑, Yes/No 토글 버튼
3. **Part III 전반 신뢰** Q24
4. **Part IV 자유응답** Q25/Q26 (선택)

조건부 문항 자동 비활성:
- Q14, Q22 — `voice` (`ftf` 또는 `sts` 모드 사용자만)
- Q16 — `video` (`ftf` 모드 사용자만)
- Q21 — `revisit` (`visitCount >= 2`)
- Q23 — `kakao` (`navigator.userAgent`에 `KAKAOTALK`)

비활성 시 버튼 disabled + "해당 없음" 표시 + 제출 시 NULL 전송.

진행 표시: `응답 N/M` (M은 활성 문항 수에 따라 동적). 학년·성별·1전공·활성 18문항·Q24 모두 응답해야 제출 활성. 자유응답·MBTI·2전공은 선택. 우상단 "건너뛰기" 옵트아웃.

### 2.4 트리거 (`src/App.jsx`)

두 경로 병행:

**A. 헤더 "설문" 버튼** — 항상 가능 (`src/components/ChatPanel.jsx` 헤더 우측, 로그인 버튼 옆 골드 톤 작은 버튼).

**B. 종료 자동 노출** — `stopAvatar()`에서 `userTurnCountRef.current >= 3` 일 때 자동 모달.

```jsx
// src/App.jsx
const lastEndedSessionIdRef = useRef(null)   // session_id 보존용
const lastEndedModesRef = useRef([])

// stopAvatar() 안에서:
if (endedSessionId) lastEndedSessionIdRef.current = endedSessionId
lastEndedModesRef.current = usedModes
if (usedTurns >= 3) {
  setSurveySessionId(endedSessionId)
  setSurveyModesUsed(usedModes)
  setSurveyOpen(true)
}
userTurnCountRef.current = 0
modesUsedRef.current = new Set()

// 헤더 "설문" 버튼 핸들러:
onOpenSurvey={() => {
  const sid = sessionIdRef.current || lastEndedSessionIdRef.current || null
  const liveModes = Array.from(modesUsedRef.current)
  const modes = liveModes.length ? liveModes : lastEndedModesRef.current
  setSurveySessionId(sid)
  setSurveyModesUsed(modes)
  setSurveyOpen(true)
}}
```

### 2.5 Vercel 프록시 — UTF-8 한글 보존

#### 발견한 버그

검증 단계에서 id=2(Vercel 경유) 행의 한글이 모두 깨져 저장됨:

```
hex_freepos = 56657263656C 20 EFBFBD EFBFBD EFBFBD EFBFBD 20 ...
              "Vercel "      �      �      �      �    " "
```

`EFBFBD`는 Unicode `U+FFFD REPLACEMENT CHARACTER`의 UTF-8 인코딩 — "이 byte를 디코드하지 못해 대체했다"는 sentinel.

#### 원인

Vercel의 자동 `bodyParser`가 charset을 잘못 잡아 `req.body`의 한글 UTF-8 multibyte byte를 한 글자마다 U+FFFD로 치환. 그 깨진 string을 `JSON.stringify`로 직렬화 후 학교 PHP에 forward → DB에 EFBFBD가 그대로 저장.

#### 수정 ([api/school-api.js](api/school-api.js))

자동 bodyParser를 끄고 raw byte stream을 그대로 forward:

```js
export const config = { api: { bodyParser: false } }

async function readRawBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

// fetch 호출 시:
headers: { 'Content-Type': 'application/json; charset=utf-8' },
body: rawBody  // Buffer 그대로 — JSON.stringify 안 거침
```

브라우저로 실제 제출한 id=4 행에서 검증: `hex_major2 = 4149 EC9D98 EBA38C EB8DB0 EC9DB4 ED84B0 ED9599` = "AI의료데이터학"의 정확한 UTF-8 ✅

### 2.6 session_id NULL 결함 fix

#### 증상

브라우저 헤더 "설문" 버튼으로 제출한 id=4 row의 `session_id`가 NULL. 그 사용자(user_id=3)는 `chat_logs`에 49건 메시지가 있는데도 설문이 어떤 채팅 세션에 대한 응답인지 join 불가.

#### 원인

`stopAvatar()`이 `sessionIdRef.current = null`로 리셋한 뒤 사용자가 헤더 버튼을 누름 → 모달 핸들러가 `sessionIdRef.current`(=null)를 읽어 NULL로 저장.

#### 수정 ([src/App.jsx](src/App.jsx))

`stopAvatar()`에서 마지막 session_id를 별도 ref(`lastEndedSessionIdRef`)에 보존하고, 헤더 버튼 핸들러가 활성 sid 없으면 그것을 사용 (위 2.4 코드 참조).

### 2.7 테스트 데이터 정리

검증 과정에서 들어간 테스트 행 3건(id=1, 2, 3) 삭제:

```sql
-- 백업 후 삭제
mysqldump --no-create-info --where="id IN (1,2,3)" \
  cha_interview_db survey_responses > survey_test_rows_backup_20260505-155316.sql
DELETE FROM survey_responses WHERE id IN (1,2,3);
```

삭제 후 1건(id=4 성봉주님 실응답)만 남음. AUTO_INCREMENT는 5 유지 (다음 응답은 id=5).

### 2.8 분석 가능 지표

- Q24 전반 신뢰 Yes 비율 + 95% CI
- 18 컴포넌트별 Yes 비율 + 신뢰구간
- 4-Layer 점수 분포 + 평균
- 4-Layer score → 전반 신뢰(Q24) 로지스틱 회귀
- 컴포넌트 × Q24 카이제곱 검정 (각 2x2 교차표)
- 18개 응답 패턴 클러스터링
- 인구통계(학년/성별/MBTI/전공)별 컴포넌트 신뢰도 차이
- 사용 모드 × 컴포넌트 효과 (chat_logs 조인)

---

## 3. 관리자 대시보드 (GitHub Pages 호환 단일 HTML)

### 3.1 백엔드 — `case 'survey_summary'`

`server/api.php`의 `handleSurveySummary()`:
- `X-Dashboard-Token` 헤더로 게이트 (env `CHA_DASHBOARD_TOKEN`과 timing-safe 비교)
- PHP 5.4 호환을 위해 `hash_equals` 대신 inline XOR 비교로 작성:
  ```php
  $eq = false;
  if (strlen($expected) === strlen($provided)) {
    $r = 0;
    for ($i = 0; $i < strlen($expected); $i++) $r |= ord($expected[$i]) ^ ord($provided[$i]);
    $eq = ($r === 0);
  }
  ```
- 반환: 총/유효 응답 수, 18 컴포넌트 yes-rate, 4-Layer 평균(만점 대비 %), 인구통계 분포(grade/gender/mbti/major1), 일별 추이, 점수 히스토그램. **개별 raw 응답이나 자유응답 텍스트는 반환하지 않음** — 개인정보 노출 차단.
- `flag_too_fast=0` 필터 적용

### 3.2 토큰 설정

`/var/www/html/interview-api/.htaccess`에 추가:
```
SetEnv CHA_DASHBOARD_TOKEN [REDACTED — 40-char dashboard token]
```
`.htaccess`는 매 요청마다 재평가되므로 Apache reload 불필요. 토큰 회전은 이 한 줄만 수정.

### 3.3 Vercel 프록시 — `X-Dashboard-Token` forward

`api/school-api.js` allowlist에 `survey_summary` 추가 + 헤더 통과:
```js
const FORWARD_HEADERS = ['x-dashboard-token', 'authorization']

const fwdHeaders = { 'Content-Type': 'application/json; charset=utf-8' }
for (const name of FORWARD_HEADERS) {
  const v = req.headers?.[name]
  if (v) fwdHeaders[name] = String(v)
}

// 또 CORS Allow-Headers에 X-Dashboard-Token 추가
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dashboard-Token')
```

### 3.4 프론트 — `public/dashboard/index.html`

단일 정적 HTML (Chart.js@4.4.4 CDN). `public/`에 두면 Vite가 빌드 시 `dist/dashboard/`로 복사 → Vercel이 그대로 서빙.

#### 호스팅 위치 결정

`dashboard/`(루트)에 만들었더니 `dist/` 밖이라 404. `public/dashboard/`로 옮겨서 해결. `vercel.json: outputDirectory: dist`이므로 빌드 산출물에 포함되어야 함.

#### URL

🌐 https://cha-interview-bot.vercel.app/dashboard/

#### 디자인 — 사이버 브루탈리즘

- **타이포**: JetBrains Mono (영문/숫자) + Pretendard (한글) Google Fonts
- **색**: 거친 검정 배경(#08090c) + 라임/시안 라디얼 글로우 + 헤어라인 보더
- **레이아웃**: 직각 코너 / `4px 4px 0 #000` hard-edge 오프셋 그림자 / 우상단 ┐ 마커
- **헤더**: sticky 상태바 — `● CHA / TRUST.SURVEY / DASHBOARD v1` 좌측, 라이브 펄스 + 노드명 + 갱신시각 중앙, `[ REFRESH ] [ TOKEN ]` 우측
- **코드틱 마커**: `//`, `>>`, `[01]` 같은 표기로 라벨 통일
- **차트 색**: L1 핫핑크 #ff2bd6 · L2 오렌지 #ff8a00 · L3 라임 #aaff00 · L4 시안 #00e5ff · 전반 골드 #ffd633

#### 차트 무한 확대 버그 수정

처음 작성 시 Chart.js + flex/grid + canvas 명시적 height 부재로 ResizeObserver 피드백 루프 발생 (차트가 매 프레임 1px씩 커짐).

수정:
```css
.chart-wrap { position: relative; width: 100%; height: 280px; }
.chart-wrap.tall { height: 540px; }
.chart-wrap canvas { display: block; }
```
```js
const COMMON = { responsive: true, maintainAspectRatio: false, animation: false, resizeDelay: 120 }
```
→ 모든 `<canvas>`를 고정 높이 `<div>`로 감싸서 Chart.js가 부모의 절대 픽셀 안에서만 그리도록 강제. ResizeObserver 루프 차단.

#### 표시 항목

1. KPI 4개 — 총응답 / 유효응답(≥60s) / Q24 Yes율 / 평균 총점(0-18)
2. 18 컴포넌트별 Yes율 — 가로 막대, Layer 색 구분
3. 4-Layer 평균 점수 — 만점 대비 %
4. 일별 응답 추이 — 응답 수 막대 + 평균 점수 라인 (이중 축)
5. 인구통계 분포 4표 — 학년·성별·1전공·MBTI

#### 토큰 입력 흐름

- 페이지 로드 시 `sessionStorage.getItem('cha_dashboard_token')` 확인 → 없으면 `prompt()`로 입력
- 헤더 우측 `[ TOKEN ]` 버튼: sessionStorage 삭제 후 재입력

---

## 4. RAG 학과 컨택 보강 (정호 학생 피드백)

### 4.1 정호 학생 피드백

> "교수님께 직접 질문하라"고 안내할 때, 학과 사무실 전화·이메일과 학과별 홈페이지 링크가 답변에 함께 오면 학생들이 더 잘 찾아볼 수 있다.

### 4.2 미들턴 RAG 시스템 위치 정리

| 항목 | 값 |
|---|---|
| 운영 호스트 | `https://middleton.p-e.kr/finbot` |
| SSH | `student04@middleton.p-e.kr:7822` (외부 22, 2022, 22022 등은 차단) |
| 서버 경로 | `/home/student04/finbot/server/` |
| RAG 데이터 | `data/cha_rag_chunks.json` + `data/cha_rag_embeddings.json` |
| 임베딩 | bge-m3 via Ollama localhost:11436, dim=1024 |
| 인터페이스 | port 9000 `/api/interview-chat` (Vercel `/api/chat`이 프록시) |
| 프로세스 관리 | pm2 `finbot-server` (`node /home/student04/finbot/server/index.js`) |
| Node | `/home/student04/.nvm/versions/node/v24.14.1/bin/node` (PATH 비활성, 절대경로 필요) |

### 4.3 사전 진단 (보강 전)

미들턴 RAG에 학과 컨택 정보 출현 0건:

| 패턴 | 개수 |
|---|---|
| `031-850-89XX` (학과 직통) | **0** |
| `031-881-7XXX` | **0** |
| `cha.ac.kr` URL (학과 홈페이지) | **0** |
| `1899-2075` (학교 대표) | **0** |
| `@cha.ac.kr` 이메일 | **0** |

라이브 API 시나리오 검증:

| 시나리오 | Before |
|---|---|
| 심리학 교수님께 직접 질문 | "교수님께 직접 여쭤보시는 걸 추천드려요" (연락처 없음) |
| AI의료데이터학과 홈페이지 | AI 경영(경영학과) 답변이 잘못 나옴 |
| 스포츠의학 사무실 | 또 경영학 답변 |

### 4.4 학과 컨택 정보 수집

차의과학대 [통합 전화번호안내](https://www.cha.ac.kr/전화번호안내/) + 11개 학과 사이트의 교수진 페이지를 종합:

| 봇 전공명 | 직통 | 학과장 | 학과 홈페이지 |
|---|---|---|---|
| 세포·유전자재생의학 | 031-881-7140 | 송지환 (jsong@cha.ac.kr) | bm.cha.ac.kr |
| 시스템생명과학 | 031-881-7137 | (페이지 미명시) | fsb.cha.ac.kr |
| 바이오식의약학 | 031-850-9320 | 홍수린 (hongsr@cha.ac.kr) | bio.cha.ac.kr |
| 디지털보건의료 | 031-850-8940 | (미명시) | aihealthcare.cha.ac.kr |
| 스포츠의학 | 031-850-8941 | (미명시) | sports.cha.ac.kr |
| 경영학 | 031-850-8944 | (미명시, 데이터경영학과 등록) | biz.cha.ac.kr |
| 미디어커뮤니케이션학 | 031-850-8945 | (미명시, 의료홍보미디어학과 등록) | comm.cha.ac.kr |
| 심리학 | 031-850-8939 | (미명시, 상담심리학과 등록) | cp.cha.ac.kr |
| AI의료데이터학 | 031-850-8952 (미래융합대학 학사지원) | (미명시) | dai.cha.ac.kr |
| 미술치료 | 031-850-8943 | (미명시) | at.cha.ac.kr |
| 소프트웨어융합 | 031-850-8952 (미래융합대학 학사지원) | (미명시) | swc.cha.ac.kr |

### 4.5 추가 chunk 11개 (`server/contact_chunks_2026-05-05.jsonl`)

`ch-121` ~ `ch-131`. 각 chunk는 `id` / `section` / `question` / `answer` / `keywords` / `embedding_text` 필드. answer에 학과 사무실 전화 + 홈페이지 + (있는 경우) 학과장 이메일 자연 문장 포함.

### 4.6 미들턴 적용

```bash
ssh -p 7822 student04@middleton.p-e.kr
cd /home/student04/finbot/server

# pscp로 업로드된 contact_chunks.jsonl 사용
export PATH=/home/student04/.nvm/versions/node/v24.14.1/bin:$PATH
node add_to_rag.js contact_chunks.jsonl
# [기존] 120 청크, 120 임베딩
# [백업] .bak.1777967822621
# [추가] 11 청크 (각 dim=1024)
# [완료] 131 청크, 131 임베딩
```

### 4.7 메모리 캐시 무효화 — pm2 restart 필수

`utils/cha-rag.js`가 모듈 로드 시 chunks/embeddings를 메모리 변수(`_chunks`, `_embeds`)에 캐시하고 다시 디스크를 읽지 않음. JSON 파일을 바꿔도 살아있는 Node 프로세스는 옛 데이터 그대로 → **pm2 restart로 프로세스를 재시작해야 새 chunk가 보임**.

```bash
pm2 restart finbot-server --update-env
```

### 4.8 retrieve 검증

`utils/cha-rag.js`의 retrieve를 직접 호출해 매칭 점수 확인:

```
"심리학 전공 교수님께 직접 질문" → ch-128 [심리학] score=0.665 (top 1) ✅
"AI의료데이터학과 홈페이지"      → ch-129 [AI의료데이터학] score=0.673 (top 1) ✅
"스포츠의학 학과 사무실 전화번호" → ch-125 [스포츠의학] score=0.788 (top 1) ✅
```

retrieve는 정확히 매칭되지만, **시스템 프롬프트가 LLM을 "경영학 전공 어시스턴트"로 한정**해서 LLM이 RAG 컨텍스트를 무시하고 일반 경영학 답변으로 빠지는 문제 별도 발생 → 시스템 프롬프트 수정 (5절).

### 4.9 외부 호출 한글 깨짐 (인프라 이슈)

같은 RAG, 같은 시스템 프롬프트인데 외부 cURL로 HTTPS 호출 시 한글 query가 깨져서 retrieve가 contact chunks를 못 잡는 현상:

```
[localhost finbot 직접]   "스포츠의학 학과 사무실..." → ch-125(0.79) top-1 ✅
[외부 HTTPS cURL]         같은 query           → ch-004(0.49) ch-009(0.48)... ❌
```

원인: 미들턴 nginx `ai.conf`에 `/finbot/...` 명시 location이 없고 default `location /` (Open-WebUI :3000)로 흘러가서 어딘가에서 charset 변환됨. 사용자 실제 경로(브라우저 → Vercel raw forward → 미들턴)는 정상 동작하므로 운영에는 영향 없음. 향후 다른 외부 클라이언트가 직접 미들턴 API를 쓸 일이 생기면 그때 nginx location 추가.

---

## 5. 시스템 프롬프트 / TTS / HeyGen 발음 정립

### 5.1 시스템 프롬프트 변경 추적 (`routes/interview-chat.js`)

#### 5.1.1 11 전공 일반화

```diff
- 경영학전공과 진로에 대한 질문에 성실히 답변합니다
+ 경영학전공과 미래융합대학 11개 전공 및 진로에 대한 질문에 성실히 답변합니다
+ 참고 자료에 학과 사무실 전화번호, 학과 홈페이지 URL, 학과장 이메일 같은 컨택 정보가 있고
+ 사용자가 그 학과에 대해 묻고 있다면, 그 정보를 답변에 자연스럽게 그대로 포함하세요
```

#### 5.1.2 컨택 안내 규칙 (최종)

```
## 컨택 안내 규칙 (reply / ttsReply 모두)
- 답변 본문에 학과 사무실 전화번호, 학과 홈페이지 URL, 학과장 이메일을 절대 직접 쓰지 마세요. 학생이 별도 카드(화면)로 보게 됩니다.
- "홈페이지는 ...", "연락처는 ...", "이메일은 ..." 같은 컨택 안내 문장도 본문에 쓰지 마세요. 본문은 전공 소개·진로·실습·자격증 같은 일반 정보로 짧게 (2~3문장).
- 마지막 안내 문구("화면에 표시해 드릴게요")는 시스템이 자동 부착합니다. 모델이 직접 적지 마세요.
```

#### 5.1.3 TTS 발음 규칙 (`cha-biz-ai-v8` 표준 + 11 전공 확장)

```
## TTS 발음 규칙 (ttsReply에만 적용, reply는 원형 유지)
- 영어 약어/고유명: CHA→차, AI→에이아이, IT→아이티, ESG→이에스지, RAG→랙, CPA→씨피에이, KAIST→카이스트, CEO→씨이오, R&D→알앤디, MBTI→엠비티아이
- 학교명: 차의과학대학교→차 의과학 대학교, 차병원→차 병원, 미래융합대학→미래 융합 대학, 경영학전공→경영학 전공
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

### 5.2 후처리 안전망

LLM이 시스템 프롬프트 룰을 안 따를 때를 대비한 정규식 후처리.

#### 5.2.1 발음 매핑 테이블

```js
const TTS_REPLACEMENTS = {
  '·': ' ',                                  // 가운뎃점 → 공백 (가장 먼저)
  // 영어 약어/고유명
  'CHA': '차', 'KAIST': '카이스트', 'CEO': '씨이오', 'CTO': '씨티오', 'CFO': '씨에프오',
  'CPA': '씨피에이', 'ESG': '이에스지', 'AI': '에이아이', 'IT': '아이티',
  'R&D': '알앤디', 'MBTI': '엠비티아이', 'RAG': '랙',
  // 학교/단위명
  '차의과학대학교': '차 의과학 대학교', '차병원': '차 병원',
  '미래융합대학': '미래 융합 대학', '경영학전공': '경영학 전공',
  // 11 전공명
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
}
```

#### 5.2.2 컨택 정보 본문 제거

reply / ttsReply 모두에서 URL, 전화번호, 이메일을 통째 삭제:

```js
.replace(/https?:\/\/[^\s)\]]+/gi, '')
.replace(/\bwww\.[^\s)\]]+/gi, '')
.replace(/\b1899[-\s]?\d{4}\b/g, '')
.replace(/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '')
.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
// LLM이 이미 한글 발음으로 변환한 케이스도 잡기
.replace(/(?:[영일이삼사오육칠팔구공]\s*){5,}/g, '')
```

#### 5.2.3 컨택 문장 통째 제거 (한글 풀이 URL 대비)

LLM이 ttsReply에 자체 변환한 한글 풀이 URL("에치티티에스피점차닷에이씨점케이알") 등이 들어가는 경우 한 문장 단위로 통째 잘라냄:

```js
.replace(/[^.!?]*?(?:홈페이지는?|연락처는|사무실\s*번호[는을]?|이메일은)[^.!?]*?(?:입니다|이에요|예요|에요|이고|이며|이니|드려요|드릴게요|돼요)\.?/g, '')
```

#### 5.2.4 한국어 조사 잔재 정리

전화번호/URL 제거 후 남는 어색한 조사:
```js
.replace(/\s*(?:는|은|이|가|을|를)\s*,/g, ',')
.replace(/\s*(?:이고|이며|이니|이에요|예요|이라|라)\s*,/g, ',')
.replace(/(?:학과 사무실 연락처는|연락처는|홈페이지는|홈페이지 주소는|이메일은)\s*[,.]/g, '')
.replace(/(?:학과 사무실 연락처는|연락처는|홈페이지는|홈페이지 주소는|이메일은)\s*$/g, '')
```

#### 5.2.5 끝 안내문 통일 부착

LLM이 자체 부착한 모든 변형을 통째 제거 후 `_contactObj` 있을 때만 한 번 부착:

```js
const _stripTail = (txt) => txt
  .replace(/[^.!?]*?화면[^.!?]{0,40}?(?:드릴게요|드려요|할게요|드립니다|드릴 ?게요)\.?/g, '')
  .replace(/\s+([.,!?])/g, '$1')
  .replace(/([.,!?])\s*([.,!?])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()
parsed.reply = _stripTail(parsed.reply)
parsed.ttsReply = _stripTail(parsed.ttsReply)
if (_contactObj) {
  const tail = '. 학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요.'
  parsed.reply = parsed.reply.replace(/[.!?]+\s*$/, '') + tail
  parsed.ttsReply = parsed.ttsReply.replace(/[.!?]+\s*$/, '') + tail
}
```

---

## 6. 컨택 카드 UI (클릭 가능 tel/mailto/링크)

### 6.1 백엔드 contact 메타필드

`routes/interview-chat.js`에 학과 매핑 + 추출 헬퍼 추가:

```js
const DEPT_CONTACTS = {
  '세포·유전자재생의학': { dept: '세포·유전자재생의학 전공', phone: '031-881-7140', homepage: 'https://bm.cha.ac.kr/', chairEmail: 'jsong@cha.ac.kr' },
  '세포유전자재생의학':  { /* 동일 — alias */ },
  '시스템생명과학':      { dept: '시스템생명과학 전공',      phone: '031-881-7137', homepage: 'https://fsb.cha.ac.kr/' },
  '바이오식의약학':      { dept: '바이오식의약학 전공',      phone: '031-850-9320', homepage: 'https://bio.cha.ac.kr/', chairEmail: 'hongsr@cha.ac.kr' },
  '디지털보건의료':      { dept: '디지털보건의료 전공',      phone: '031-850-8940', homepage: 'https://aihealthcare.cha.ac.kr/' },
  '스포츠의학':          { dept: '스포츠의학 전공',          phone: '031-850-8941', homepage: 'https://sports.cha.ac.kr/' },
  '경영학':              { dept: '경영학 전공',              phone: '031-850-8944', homepage: 'https://biz.cha.ac.kr/' },
  '미디어커뮤니케이션학':{ dept: '미디어커뮤니케이션학 전공',phone: '031-850-8945', homepage: 'https://comm.cha.ac.kr/' },
  '심리학':              { dept: '심리학 전공',              phone: '031-850-8939', homepage: 'https://cp.cha.ac.kr/' },
  'AI의료데이터학':      { dept: 'AI의료데이터학 전공',      phone: '031-850-8952', homepage: 'https://dai.cha.ac.kr/', note: '미래융합대학 학사지원실' },
  '미술치료':            { dept: '미술치료 전공',            phone: '031-850-8943', homepage: 'https://at.cha.ac.kr/' },
  '소프트웨어융합':      { dept: '소프트웨어융합 전공',      phone: '031-850-8952', homepage: 'https://swc.cha.ac.kr/', note: '미래융합대학 학사지원실' }
}

// userMessage 학과명 직접 매칭 우선, retrieve fallback
function pickContactFromHits(hits, userMessage) {
  const norm = (userMessage || '').replace(/\s+/g, '')
  // 길이 내림차순 — "미디어커뮤니케이션학"이 "심리학"보다 먼저 매칭되도록
  const keys = Object.keys(DEPT_CONTACTS).sort((a, b) => b.length - a.length)
  for (const sec of keys) {
    const variants = new Set([sec, sec.replace('·', ''), sec + '과', sec + '전공'])
    for (const v of variants) {
      if (v && norm.includes(v.replace(/\s+/g, ''))) return DEPT_CONTACTS[sec]
    }
  }
  if (hits && hits.length) {
    const contactHit = hits.find(h => /^ch-12\d$/.test(h.id || ''))
    if (contactHit && DEPT_CONTACTS[contactHit.section]) return DEPT_CONTACTS[contactHit.section]
  }
  return null
}
```

매핑 오류 fix 이력:
- 1차 시도: retrieve hits 우선 → "미술치료 사무실" 질문에 retrieve가 ch-128(심리학)을 ch-130(미술치료)보다 score 높이 잡아서 잘못 매핑
- 2차 시도 (현재): userMessage 학과명 직접 매칭 우선 + 키 길이 내림차순 검사 → 11/11 정확

응답 객체에 부착:
```js
if (_contactObj) parsed.contact = _contactObj
return res.status(200).json(parsed)
```

### 6.2 Vercel api/chat.js 통과

`sanitizeResponse`가 spread `...data`이므로 `contact` 필드 자동 통과:
```js
return { ...data, reply: ..., ttsReply: ... }   // contact 자동 forward
```

### 6.3 프론트 — App.jsx에서 메시지에 부착

```js
setMessages(prev => {
  const next = [...prev]
  next[next.length - 1] = { role: 'assistant', text: reply, contact: data.contact || null }
  return next
})
```

### 6.4 ChatPanel.jsx — `<ContactCard>` 컴포넌트

```jsx
function ContactCard({ contact }) {
  const { dept, phone, homepage, chairEmail, note } = contact
  return (
    <div className={styles.contactCard}>
      <div className={styles.contactHead}>
        <span className={styles.contactDept}>{dept}</span>
        {note && <span className={styles.contactNote}>{note}</span>}
      </div>
      <div className={styles.contactRows}>
        {phone && <a className={styles.contactRow} href={`tel:${phone}`}>
          <span>학과 사무실</span><span>{phone}</span></a>}
        {homepage && <a className={styles.contactRow} href={homepage} target="_blank" rel="noopener noreferrer">
          <span>학과 홈페이지</span><span>{homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></a>}
        {chairEmail && <a className={styles.contactRow} href={`mailto:${chairEmail}`}>
          <span>학과장 이메일</span><span>{chairEmail}</span></a>}
      </div>
    </div>
  )
}

function Message({ msg }) {
  return (
    <div className={...}>
      {!isUser && <div className={styles.avatar}>AI</div>}
      <div className={styles.msgBody}>
        <div className={...}>{msg.text === null ? <TypingDots /> : msg.text}</div>
        {!isUser && msg.contact && <ContactCard contact={msg.contact} />}
      </div>
    </div>
  )
}
```

### 6.5 클릭 동작

| 항목 | href | 모바일 동작 |
|---|---|---|
| 전화번호 | `tel:031-850-8939` | 전화 앱 자동 실행 (전화 걸기 화면) |
| 홈페이지 | `target="_blank" rel="noopener noreferrer"` | 새 탭에서 열림 |
| 학과장 이메일 | `mailto:jsong@cha.ac.kr` | 메일 앱 실행 |

### 6.6 CSS — 골드 톤 카드

`src/components/ChatPanel.module.css`에 `.contactCard`, `.contactHead`, `.contactDept`, `.contactNote`, `.contactRows`, `.contactRow`, `.contactLabel`, `.contactValue` 추가. 모바일 미디어 쿼리에서 padding/font-size 축소.

---

## 7. 운영 인프라 변경 사항 종합

### 7.1 학교 서버 (aiforalab.com:10022, user2)

| 변경 | 내용 |
|---|---|
| `/etc/httpd/conf.d/interview-api.conf` | 신설 — `<Directory "/var/www/html/interview-api"> AllowOverride All; Require all granted; </Directory>` |
| `/var/www/html/interview-api/.htaccess` | `SetEnv CHA_DASHBOARD_TOKEN [REDACTED — 40-char dashboard token]` 1줄 추가 |
| `/var/www/html/interview-api/api.php` | v0(Likert) → v1(Yes/No) 교체 + `case 'survey_summary'` 추가 + PHP 5.4 호환 timing-safe compare |
| `/var/www/html/interview-api/api.php.bak.*` | 시점별 백업 보존 (`v1deploy-20260505-142830`, `summary-20260505-153432`) |
| MySQL `cha_interview_db.survey_responses` | 39 컬럼 v1 테이블 신설 |

### 7.2 미들턴 서버 (middleton.p-e.kr:7822, student04)

| 변경 | 내용 |
|---|---|
| `/home/student04/finbot/server/data/cha_rag_chunks.json` | 120 → **131** chunks (ch-121~ch-131 학과 컨택 추가) |
| `/home/student04/finbot/server/data/cha_rag_embeddings.json` | 동일 — 131 임베딩 (각 dim=1024) |
| `/home/student04/finbot/server/data/*.bak.*` | 시점별 백업 보존 — 가장 최근 `bak.1777967822621` (오늘 16:57, 120-chunk 시점) |
| `/home/student04/finbot/server/routes/interview-chat.js` | 다회 패치 — DEPT_CONTACTS, contact 메타필드, 시스템 프롬프트, 발음 후처리 |
| `/home/student04/finbot/server/routes/interview-chat.js.bak.*` | 시점별 백업 (`170713`, `172107`, `172221`, `172537`, `173058`, `173250`, `173946`) |
| pm2 `finbot-server` | 다회 restart (255 → 262) — 모듈 캐시 무효화 |

### 7.3 Vercel (cha-interview-bot.vercel.app)

다음 master 푸시들이 자동 배포됨:

| Commit | 내용 |
|---|---|
| `ff4f23f` | feat: trust component survey v1 with header trigger button |
| `352395c` | fix(school-api): forward raw UTF-8 body to preserve Korean |
| `261bfcd` | fix(survey): preserve session_id for header-button submissions |
| `53b45c9` | feat: trust survey aggregation API + GitHub Pages dashboard |
| `6455a57` | fix(survey-summary): replace hash_equals with PHP 5.4-compatible compare |
| `dc37b96` | fix(dashboard): move into public/ so Vite includes it in dist/ |
| `0ded0f8` | fix(dashboard): stop infinite chart resize + simplify layout |
| `854ba23` | style(dashboard): cyber-brutal redesign |
| `7c518ca` | feat(rag): department contact chunks + TTS strips URLs/phones |
| `703ec6d` | feat(chat): contact card UI with clickable tel/mailto/link |

### 7.4 GitHub 레포

- 운영 RAG는 우리 git 레포와 자동 동기화되지 않음 — `add_to_rag.js`를 미들턴에서 직접 실행해야 반영됨
- Vercel 자동 배포는 master push에서만 동작
- 학교 서버 PHP는 SSH로 직접 업로드 + `sudo cp`

---

## 8. 미해결 / 후속 작업

### 8.1 후속 권장

1. **카카오 로그인 시 개인정보 동의 UI** (김종석 교수 피드백)
   - AuthModal에 동의 박스 1개(체크 안 하면 카카오/이메일 버튼 disabled) + 처리방침 details 영역
   - 옵션: `users.consent_version` / `consent_at` 컬럼 추가로 감사 대비
2. **노출된 자격증명 회전** — 본 문서·로그·git history에 평문으로 남은 학교 DB pass(`[REDACTED]`), JWT secret, 대시보드 토큰. 우선순위는 사용자 결정.
3. **미들턴 nginx `/finbot/` location 명시** — 외부 cURL 직접 호출 시 한글 깨짐 해결. 사용자 실 흐름엔 영향 없음.
4. **운영 `survey_responses` 테이블에 미술치료/소프트웨어융합 학과 직통 갱신** — 학과 직통이 부여되는 즉시 chunk 한 번만 갈아끼우면 됨.
5. **설문 자유응답(Q25/Q26) 분석** — 키워드 빈도, 주제 분류. 별도 후속.
6. **대시보드 추가 차트** — Q24 ↔ 4-Layer 로지스틱 회귀, 컴포넌트 × Q24 카이제곱, 자유응답 워드클라우드.
7. **`chat_logs.rag_hits` 항상 NULL** — 미들턴 응답에 `rag` 필드가 없어서 클라이언트가 매칭 chunk를 못 받음. 운영 분석 필요 시 미들턴 응답에 `rag` 또는 `hits` 메타 추가.

### 8.2 알려진 작은 이슈

- 컨택 chunk가 retrieve top-K에 없는 학과의 경우 `pickContactFromHits`의 첫 번째 검사(userMessage 직접 매칭)에 의존. 사용자가 학과명을 정확히 적어주지 않으면 컨택 카드 미표시. 향후 학과명 변형(별칭) 사전 확장 가능.
- `미술치료`, `소프트웨어융합` 학과는 직통 번호 자체가 없어서 `미래융합대학 학사지원실` 8952로 통합 안내. `note: '미래융합대학 학사지원실'`이 카드 헤더에 함께 표시됨.

---

## 9. 검증 결과 요약 (최종)

### 9.1 정호 학생 피드백 — 충족 상태

- ✅ "교수님께 직접 질문" 안내 시 학과 사무실 번호·홈페이지가 화면에 함께 표시 (별도 카드 UI)
- ✅ 특정 학과 관심 시 학과별 홈페이지 링크가 컨택 카드로 노출 + 클릭 시 새 탭으로 이동
- ✅ 음성 모드에서는 URL/전화번호를 자연어("학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요")로 끝맺어 길게 읽지 않음
- ✅ 11/11 학과 매핑 정확 (자동 cURL 검증)

### 9.2 박대근 교수 — 설문 시스템

- ✅ DB 테이블 정상 (39 컬럼, FK·index 모두)
- ✅ 헤더 "설문" 버튼 + 종료 자동 노출 두 경로 동작
- ✅ Vercel raw body forward로 한글 정상 저장 (id=4 hex 검증)
- ✅ session_id 보존 (lastEndedSessionIdRef 패치)
- ✅ 대시보드 ([https://cha-interview-bot.vercel.app/dashboard/](https://cha-interview-bot.vercel.app/dashboard/)) — KPI + 18 컴포넌트 yes-rate + 4-Layer + 일별 추이 + 인구통계

### 9.3 운영 안정성

- ✅ 카카오 로그인 복구 (Apache .htaccess 평가됨)
- ✅ 미들턴 finbot-server pm2 정상 (262회 restart 누적)
- ✅ 학교 PHP `interview-api/api.php` v1 정상 (handleSaveSurvey + handleSurveySummary)
- ✅ FK 무결성 0 violations (chat_logs / survey_responses)

---

## 10. 참고 — 주요 파일 위치

### 레포 (master)

- `server/api.php` — PHP API 본체
- `server/schema.sql` — DB 스키마
- `server/contact_chunks_2026-05-05.jsonl` — 11 학과 컨택 chunk JSONL
- `server/verify_survey_save_2026-05-05.sh` — E2E cURL 검증
- `api/school-api.js` — Vercel 프록시 (raw body forward + X-Dashboard-Token forward)
- `api/chat.js` — Vercel 채팅 프록시 (sanitize)
- `src/App.jsx` — 메인 앱, sendMessage 처리, 설문 트리거
- `src/components/SurveyModal.jsx` + `.module.css` — 설문 UI
- `src/components/ChatPanel.jsx` + `.module.css` — 채팅 + 컨택 카드 + 헤더 설문 버튼
- `src/lib/api.js` — saveChat, saveSurvey
- `src/lib/trustComponents.js` — 18문항 메타데이터
- `public/dashboard/index.html` — 대시보드 단일 HTML
- `docs/internal-survey-implementation-2026-05-05.md` — 설문 구현 사양
- `docs/survey-design-2026-05-05.md` — 교수님 보고용 설문 디자인
- `docs/rag-analysis-report-2026-05-05.md` — RAG 분석 (오전)
- `docs/rag-detailed-update-plan-2026-05-05.md` — RAG 상세 보강 초안
- `docs/rag-contact-update-2026-05-05.md` — 학과 컨택 chunk 보강 가이드
- `docs/development-log-2026-05-05.md` — **이 문서**

### 학교 서버 (aiforalab.com:10022)

- `/var/www/html/interview-api/api.php` — 운영 PHP
- `/var/www/html/interview-api/.htaccess` — SetEnv 4줄
- `/etc/httpd/conf.d/interview-api.conf` — AllowOverride All

### 미들턴 (middleton.p-e.kr:7822)

- `/home/student04/finbot/server/index.js` — finbot 엔트리
- `/home/student04/finbot/server/routes/interview-chat.js` — 본 작업 핵심 (시스템 프롬프트, 후처리, contact 추출)
- `/home/student04/finbot/server/utils/cha-rag.js` — retrieve (모듈 캐시)
- `/home/student04/finbot/server/data/cha_rag_chunks.json` — 131 chunks
- `/home/student04/finbot/server/data/cha_rag_embeddings.json` — 131 vectors (dim 1024)
- `/home/student04/finbot/server/add_to_rag.js` — chunk 추가 도구

---

## 11. 대시보드 USAGE 섹션 추가 (Phase A — 사용자 정보 및 활동 통계)

기존 대시보드(`survey_summary` 한 액션)는 신뢰 컴포넌트 설문 결과만 보여줬다. 박대근 교수님이 "사용자 정보·접속자·세션 체류" 같은 운영 지표도 한 화면에서 보길 원하셨고, 김종석 교수님 동의 UI가 아직이라는 정책 제약을 감안해 **PII 노출 0인 집계 통계만** 추가하는 Phase A를 진행했다.

### 11.1 새 액션 — `usage_summary`

`server/api.php`에 `handleUsageSummary` 추가. `survey_summary`와 동일한 `X-Dashboard-Token` 게이트(timing-safe XOR, PHP 5.4 호환). 채팅 메시지 본문, 이메일·카카오id는 응답에 포함하지 않는다.

응답 구조:

```json
{
  "success": true, "as_of": "...",
  "totals": {
    "users_total":16, "users_kakao":12, "users_email":4,
    "sessions_total":133, "messages_total":489,
    "user_messages":183, "bot_messages":306,
    "anon_messages":53, "anon_sessions":17
  },
  "session_avg": { "seconds":119.4, "minutes":1.99, "turns":2.23 },
  "signups":  [{ "d":"2026-05-02","n":4 }, ...],
  "activity": [{ "d":"2026-05-02","sessions":6,"active_users":4 }, ...],
  "turn_hist": { "bin_1":..,"bin_2":..,"bin_3":..,"bin_4_5":..,"bin_6_10":..,"bin_11p":.. },
  "hourly":   [{ "h":0,"n":.. }, ...],
  "revisit":  [{ "vc":1,"n":.. }, ...],
  "top_users": [
    { "id":5, "name":"박대근", "login_type":"kakao",
      "visit_count":7, "last_login":"2026-05-05 00:29:42",
      "msgs":141, "user_msgs":54, "sessions":37 }, ...
  ]
}
```

### 11.2 SQL — 집계 쿼리

| 지표 | 쿼리 |
|---|---|
| 총합 KPI | 9개 단일값 (users 3종, sessions, messages 4종, anonymous 2종) — `(SELECT COUNT...)` UNION 형태 한 줄 |
| 평균 세션 체류 | `AVG(TIMESTAMPDIFF(SECOND, MIN, MAX) GROUP BY session_id HAVING COUNT(*)>=2)` |
| 평균 사용자 턴 | `AVG(SUM(role='user') GROUP BY session_id)` |
| 일별 신규 가입 | `users GROUP BY DATE(created_at)` |
| 일별 활성 | `chat_logs GROUP BY DATE(created_at)` — sessions distinct + active user_id distinct |
| 세션 턴 히스토그램 | `chat_logs GROUP BY session_id` 한 번 → 외부에서 `SUM(CASE)` 6개 bin |
| 시간대 분포 | `WHERE role='user' GROUP BY HOUR(created_at)` |
| 재방문 분포 | `users GROUP BY visit_count` |
| Top 10 사용자 | `users` + `chat_logs.user_id` 서브쿼리 — 메시지 수 desc 10건 |

`Top users`에서 **이메일·kakao_id는 SELECT 절에서 제외** — `name`, `login_type` 태그(kakao/email/other), 활동 카운트만 노출.

### 11.3 Vercel 프록시 (`api/school-api.js`)

`ALLOWED_ACTIONS`에 `usage_summary` 추가만. 기존 `X-Dashboard-Token` forward 그대로 동작.

### 11.4 프론트 (`public/dashboard/index.html`)

#### 페이지 구조 — 두 섹션으로 분리

```
┌─ topbar (sticky) ───────────────────────────────────────┐
│  ● CHA / USAGE + TRUST.SURVEY / DASHBOARD v2            │
└─────────────────────────────────────────────────────────┘
┌─ USAGE 섹션 (라임 좌측 바) ──────────────────────────────┐
│  KPI 4개:  users_total / sessions_total /                │
│           messages_total / avg_session_duration          │
│  CHARTS:                                                 │
│   - DAILY ACTIVITY (신규 가입 bar + 활성 line + 세션 line)│
│   - SESSION TURN DIST (1/2/3/4-5/6-10/11+)              │
│   - HOURLY USAGE (0-23시)                                │
│   - SIGNUP TYPE 도넛 (카카오/이메일/익명세션)              │
│   - REVISIT DISTRIBUTION (visit_count)                   │
│  TABLE: TOP USERS — id/name/type/msgs/user_msgs/         │
│         sessions/visits/last_login                       │
└─────────────────────────────────────────────────────────┘
┌─ TRUST SURVEY 섹션 (시안 좌측 바) ────────────────────────┐
│  KPI 4개 + 18 컴포넌트 + 4-Layer + 일별 추이 + 인구통계    │
└─────────────────────────────────────────────────────────┘
```

#### 데이터 로드

`Promise.all([callApi('usage_summary'), callApi('survey_summary')])`로 병렬 호출. 한쪽이라도 실패하면 전체 에러 표시.

#### KPI 카드 디자인

기존 사이버 브루탈 팔레트 유지 — `data-c="lime|cyan|mag|gold|plum|orange"` 좌측 액센트 바 + `[U-01]` / `[S-01]` 인덱스. USAGE는 `[U-01]~[U-04]`, SURVEY는 `[S-01]~[S-04]`로 구분.

#### Top Users 테이블

- `login-tag` 클래스로 `kakao` (골드 톤) / `email` (시안 톤) 구분 chip
- `last_login` 한국 로케일 포맷 (`toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })`)
- 호버 시 lime 틴트 (`tr:hover td`)

### 11.5 운영 배포

1. 로컬에서 `server/api.php` 수정 (handleUsageSummary 추가, switch case 추가)
2. `pscp -P 10022 -hostkey SHA256:tEO+v8Z585KLBFzpmFfsT/Lo0VnNAPO8xCA4nJDLlL8 -batch -pw '[REDACTED]' server/api.php user2@aiforalab.com:/tmp/api_v2_usage.php`
3. SSH로 백업 (`api.php.bak.usage-<timestamp>`) → `cp /tmp/api_v2_usage.php /var/www/html/interview-api/api.php`
4. `php -l` syntax check → No syntax errors
5. 토큰 없는 cURL → `{"success":false,"error":"invalid dashboard token"}` (가드 정상)
6. 정상 토큰 cURL → 풍부한 집계 JSON (16 users, 133 sessions, 489 messages 등)

학교 PHP는 매 요청마다 재해석되므로 Apache reload 불필요.

### 11.6 대시보드 v2 검증 결과 (실제 운영 응답)

| 메트릭 | 값 |
|---|---|
| users_total | 16 (카카오 12 / 이메일 4) |
| sessions_total | 133 (익명 17 포함) |
| messages_total | 489 (user 183 / bot 306) |
| 익명 메시지 | 53건 |
| 평균 세션 체류 | **1.99분** (turns ≥ 2 세션 대상) |
| 평균 사용자 턴 | **2.23회** |
| 일별 신규 가입 | 5/2:4 / 5/3:1 / 5/4:6 / 5/5:5 |

### 11.7 정책 — 채팅 메시지 본문은 노출 안 함

- 메시지 카운트·시각만 노출
- 이메일·kakao_id는 응답에 포함 안 함 (이름과 login_type 태그까지만)
- 자유응답 텍스트는 `survey_summary`에서도 반환 안 함 (이미 적용)
- 향후 채팅 본문을 운영자가 보려면 — (a) 김종석 교수 피드백 반영해 회원가입 동의에 "운영진은 품질 개선·연구 목적으로 채팅 내용을 익명 열람할 수 있다" 명시, (b) admin 권한 시스템 (`users.role`) 도입, (c) 누가 언제 무엇을 봤는지 audit log

이 세 가지가 갖춰진 뒤 Phase B/C로 진행 (현재는 Phase A로 마침).

### 11.8 관련 파일

- 백엔드: [server/api.php](server/api.php) — `handleUsageSummary`
- 프록시: [api/school-api.js](api/school-api.js) — allowlist
- 프론트: [public/dashboard/index.html](public/dashboard/index.html) — v2

### 11.9 commit

`abc1fb7 feat(dashboard): usage stats panel — users, sessions, activity (no PII)` — 3 files changed, 492 insertions.

---

## 12. 변경 이력

- 2026-05-05 (오늘) — 본 문서 v1. 운영 카카오 로그인 복구, 신뢰 컴포넌트 설문 v1 구축, 대시보드 출시, RAG 학과 컨택 보강, HeyGen 발음 정립, 컨택 카드 UI 도입까지 일괄 정리.
- 2026-05-05 (저녁 후속) — v1.1. 대시보드 USAGE 섹션(Phase A) 추가 — `usage_summary` 액션 + KPI 4개 + 차트 5개 + Top Users 표. PII 노출 0 정책 명시.
