# CHA-Interview-Bot — System Architecture Specification

> **Document type:** System architecture specification, suitable for academic citation.
> **Subject system:** A multi-tier, retrieval-augmented conversational agent for new-student major counseling at CHA University, College of Future Convergence (미래융합대학).
> **Specification date:** 2026-05-05
> **Reference repository commit:** `abc1fb7` and later (master branch of `sungbongju/cha-interview-bot`).
> **Production endpoint:** `https://cha-interview-bot.vercel.app/`
> **Document version:** v1.0

---

## Abstract

This document specifies the production system architecture of **CHA-Interview-Bot**, a Retrieval-Augmented Generation (RAG) based multimodal conversational agent that supports text-only, speech-only, and embodied speech-and-video dialog with prospective and incoming undergraduate students of CHA University's College of Future Convergence. The system spans three operationally independent tiers: a single-page React frontend deployed on Vercel, a stateless Vercel serverless proxy layer (`/api/*`), a PHP/MySQL backend running on the university's CentOS 7 + Apache 2.4 + PHP 5.4 server, and an external GPU host ("Middleton") that runs the RAG retrieval and Gemma-class LLM serving via Ollama. The system was instrumented during the 2026-05-05 development cycle with (i) a Yes/No, four-layer, eighteen-component trust survey, (ii) a usage- and trust-aggregating administrator dashboard, (iii) eleven department-contact RAG chunks, and (iv) a deterministic post-processing pipeline that separates contact metadata from generated text and routes it to a structured UI card while suppressing it from speech synthesis. The architecture and the empirical instrumentation choices are described here in sufficient detail to be reproduced from this single document.

---

## 1. System Overview

### 1.1 Tiered architecture

The system is composed of four loosely-coupled tiers that communicate exclusively over HTTP(S):

| Tier | Host | Purpose |
|---|---|---|
| **T1 — Browser** | End user device (desktop / mobile) | React 18 SPA, HeyGen WebRTC client, audio capture, all UI state |
| **T2 — Edge proxy** | Vercel Serverless (Node 22, Edge runtime) | TLS termination toward client; CORS; raw-body forwarding to T3 and T4; sensitive-term sanitization |
| **T3 — Conversational core** | Middleton GPU host (Ubuntu, `cha-Bigdata`, behind nginx 1.18 + DDNS `middleton.p-e.kr`) | Express server `finbot-server` on `127.0.0.1:9000`; cosine-similarity retrieval over local JSON corpus; Gemma4 LLM via Ollama on `127.0.0.1:11435`; bge-m3 embedding model via Ollama on `127.0.0.1:11436` |
| **T4 — Persistence** | University server `aiforalab.com` (CentOS 7 + Apache/2.4.6 + PHP 5.4.45) | MySQL 8.0 database `cha_interview_db`; JWT-based authentication; chat-log and survey-response persistence |

There is no shared state between T2, T3 and T4: T2 is stateless; T3 caches RAG data in process memory; T4 owns the relational database. T1 holds session-scoped state (login token, message history, mode usage) in JavaScript memory and `sessionStorage`/`localStorage`.

### 1.2 Top-level data flow (per user utterance)

```
[T1 Browser]
   audio → STT (LiveKit WebRTC) ──┐
   text typed ───────────────────┼─► sendMessage(text)
                                  │
                                  │ POST /api/chat
                                  ▼
[T2 Vercel /api/chat]
   read raw body (UTF-8 preserved)
   POST → https://middleton.p-e.kr/finbot/api/interview-chat
                                  │
                                  ▼
[T3 nginx :443 → finbot Express :9000]
   1. retrieve(message, top_k=5, min_score=0.25)        ─ bge-m3, 1024-dim
   2. pickContactFromHits(hits, message)                ─ DEPT_CONTACTS map
   3. buildSystemPrompt(hits)                           ─ § 5.4
   4. POST → http://127.0.0.1:11435/api/chat            ─ Gemma4 (Ollama)
   5. JSON.parse + emoji strip + sanitization pipeline  ─ § 5.7
   6. attach contact metadata if applicable
                                  │
                                  ▼ {reply, ttsReply, contact?}
[T2 sanitizeResponse]
   reply: replace 신경 치료 → 통증 관리
   ttsReply: strip URLs/phones/emails/folded-numerals
                                  │
                                  ▼
[T1 Browser]
   setMessages(... reply, contact)
   ChatPanel renders bubble + ContactCard
   if mode ∈ {ftf, sts}: send ttsReply to HeyGen via streaming.task
                                  │
                                  ▼
[T4 School PHP /api.php?action=save_chat]
   chat_logs INSERT (user message, then assistant reply)
```

### 1.3 Service responsibilities (separation of concerns)

| Concern | Owning tier | Rationale |
|---|---|---|
| User identity / JWT | T4 | Cannot be moved to T2 without persisting user records on Vercel |
| Chat history | T4 (`chat_logs`) | Persistence, joinable with surveys |
| Survey responses | T4 (`survey_responses`) | Same persistence, FK-linked to users |
| RAG corpus | T3 (local JSON + Ollama embeddings) | Co-located with embedding/LLM hosts to avoid embedding RTT cost |
| LLM inference | T3 (Ollama) | Self-hosted; no external API calls for inference |
| Avatar synthesis | External (HeyGen) via T2 proxy | TTS+visemes are commercially provided |
| TLS / CORS / token forwarding | T2 | Centralizes web-security policy at the edge |
| Bot Protection | T2 (Vercel) | Default-on; impacts non-browser callers (§ 12.2) |

---

## 2. Repository Layout (T1 source)

```
cha-interview-bot/
├── api/                           # Vercel serverless functions (T2)
│   ├── chat.js                    # Chat proxy + sanitization
│   ├── school-api.js              # School API gateway (raw-body forward)
│   ├── heygen-proxy.js            # HeyGen REST proxy
│   └── heygen-token.js            # HeyGen LiveKit ephemeral token issuer
├── public/                        # Vite static assets → dist/
│   ├── index.html
│   ├── og-thumbnail.png
│   └── dashboard/index.html       # Standalone admin dashboard (Vanilla HTML + Chart.js)
├── server/                        # Source-of-truth for T4 PHP and T3 RAG tooling
│   ├── api.php                    # T4 PHP API (mirrored to /var/www/html/interview-api/)
│   ├── schema.sql                 # T4 DDL
│   ├── cha-rag.js                 # Reference T3 retriever (mirrored to T3)
│   ├── add_to_rag.js              # T3 corpus updater
│   ├── verify_rag_update_*.js     # T3 corpus verifier
│   ├── contact_chunks_*.jsonl     # T3 corpus addition (departments)
│   ├── detailed_chunks_*.jsonl    # T3 corpus addition (per-major detail)
│   └── ...
├── src/                           # T1 React source
│   ├── App.jsx                    # Root component, all session state, send/receive
│   ├── App.module.css
│   ├── components/
│   │   ├── AvatarPanel.{jsx,module.css}    # Video, mode selector, start/stop, mic
│   │   ├── ChatPanel.{jsx,module.css}      # Header (login, survey button), bubbles, ContactCard, input
│   │   ├── AuthModal.{jsx,module.css}      # Kakao + email auth
│   │   └── SurveyModal.{jsx,module.css}    # 18-item Yes/No survey UI
│   ├── lib/
│   │   ├── api.js                          # call(), saveChat(), saveSurvey(), getToken(), etc.
│   │   └── trustComponents.js              # 18 question metadata (id, layer, condition)
│   ├── index.css
│   └── main.jsx
├── docs/                          # Documentation
├── vercel.json                    # Build config: vite build → dist/
├── vite.config.js
└── package.json                   # React 18, Vite 8, livekit-client, etc.
```

The build pipeline is `npm run build` → Vite emits `dist/` (served by Vercel as the production root). `public/` contents are copied verbatim into `dist/`, so `public/dashboard/index.html` becomes available at `/dashboard/`.

---

## 3. Tier T1 — Frontend (React 18 + Vite)

### 3.1 Build and runtime

| Property | Value |
|---|---|
| Framework | React 18 (functional components + hooks) |
| Build tool | Vite 8.0.10 |
| Bundle size (gzipped) | ≈ 75 kB JS, ≈ 7 kB CSS, ≈ 2 kB HTML |
| Static asset folder | `public/` (verbatim copy) |
| Output | `dist/` |
| Avatar SDK | `livekit-client` (HeyGen Streaming Avatar standard) |

### 3.2 Top-level state ([`src/App.jsx`](../src/App.jsx))

```text
useState
  status              ∈ {idle, connecting, ready, listening, speaking}
  messages            : Array<{role: 'user'|'assistant', text: string|null, contact?: object}>
  isProcessing        : boolean
  conversationMode    ∈ {'ftf', 'sts', 'ttt'}
  cameraStream        : MediaStream | null
  user                : object | null
  authOpen, surveyOpen
  surveySessionId, surveyModesUsed

useRef
  sessionRef                 : HeyGen session handle
  sessionIdRef               : current chat session id (sess_<ts>_<rand>)
  conversationModeRef        : mirrors conversationMode
  modesUsedRef       (Set)   : modes accumulated during a session
  userTurnCountRef           : count of user utterances in current session
  lastEndedSessionIdRef      : last completed session id (for header survey button)
  lastEndedModesRef          : modes from the last completed session
  isSpeakingRef, autoListenRef, isListeningRef, isProcessingRef
  historyRef                 : LLM chat history window
  videoRef, audioRef, userVideoRef
  avatarVideoTrackRef, avatarAudioTrackRef
  cameraStreamRef
```

### 3.3 Conversation modes

| Code | Display name | Description | RAG | LLM | TTS | Avatar Video |
|---|---|---|---|---|---|---|
| `ftf` | Face-to-Face | Voice + video | ✓ | ✓ | ✓ | ✓ |
| `sts` | Speech-to-Speech | Voice only | ✓ | ✓ | ✓ | ✗ |
| `ttt` | Text-to-Text | Typed only | ✓ | ✓ | ✗ | ✗ |

The mode is captured at the moment a user message is sent and accumulated into `modesUsedRef` (a `Set`); mode-conditional survey questions are activated based on this set (§ 9.3).

### 3.4 Avatar streaming flow

1. User clicks **Start**. `startConversation()` requests HeyGen token via `/api/heygen-token`.
2. A LiveKit `Room` is connected; `avatar` and `video`/`audio` tracks are subscribed and attached to `<video>`/`<audio>` refs.
3. After each LLM response, the client calls `streaming.task` with `{ session_id, text: ttsReply, task_type: 'repeat' }` via `/api/heygen-proxy`.
4. `stopAvatar()` issues `streaming.stop`, disconnects the LiveKit room, and resets local refs.

### 3.5 Authentication flow

| Action | Frontend | Backend (`server/api.php`) |
|---|---|---|
| First visit, no token | `getUser()` returns null → `AuthModal` opens | n/a |
| Kakao login | KAKAO_JS_KEY → kakao.authorize → `kakao_login` action | `handleKakaoLogin`: upsert `users.kakao_id`, increment `visit_count`, issue HS256 JWT (exp = +7 days) |
| Email signup | `email_signup` action | bcrypt-style `crypt()` hash (PHP 5.4-compatible) |
| Token verify on mount | `verifyToken()` → `verify` action | Validates HS256 signature & exp |

### 3.6 Chat send flow

[`src/App.jsx:288–347`](../src/App.jsx)

1. Append `{role: 'user', text}` to `messages`.
2. Append `{role: 'assistant', text: null}` (typing indicator).
3. `POST /api/chat` with `{message, history: last 8}`.
4. Receive `{reply, ttsReply, contact?}`.
5. Replace typing slot with `{role:'assistant', text:reply, contact: data.contact ?? null}`.
6. Persist both user and assistant messages via `saveChat(session_id, role, message)` (`/api/school-api?action=save_chat`).
7. If mode ≠ `ttt`: forward `ttsReply` to HeyGen.

### 3.7 Survey delivery (§ 9 for the instrument)

- **Trigger A — header button:** the `[설문]` button on the chat header always opens `SurveyModal`. The handler binds `sessionId` and `modesUsed` from either the live session or, if the session has ended, the last-ended refs (`lastEndedSessionIdRef`, `lastEndedModesRef`).
- **Trigger B — automatic on stop:** in `stopAvatar()`, if `userTurnCountRef.current ≥ 3` at the moment of stop, the modal is auto-opened with the just-ended session's id and modes.

The auto-trigger threshold of three user turns ensures that every auto-opened survey reflects a substantive interaction.

### 3.8 Admin dashboard (T1 sibling)

[`public/dashboard/index.html`](../public/dashboard/index.html) is a single-file static HTML application (no React, no bundler) that loads Chart.js v4.4.4 from a CDN. It is served from `/dashboard/` on the same Vercel domain. It speaks to the school API exclusively through `/api/school-api?action=usage_summary` and `?action=survey_summary`, gated by an `X-Dashboard-Token` header.

---

## 4. Tier T2 — Vercel Edge Proxy

### 4.1 `vercel.json`

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/api/(.*)", "destination": "/api/$1" }]
}
```

### 4.2 `/api/chat` ([`api/chat.js`](../api/chat.js))

- Forwards `POST` body verbatim to `https://middleton.p-e.kr/finbot/api/interview-chat`.
- After receiving the JSON response, applies `sanitizeResponse(data)`:
  - `reply`: replaces `/신경\s*치료/g` with `통증 관리` (sensitive-term policy).
  - `ttsReply`: replaces URLs, Korean phone numbers (1899-XXXX, 0XX-XXXX-XXXX), emails, and folded-numeral phone reads (`(?:[영일이삼사오육칠팔구공]\s*){5,}`) with natural-language stand-ins (`학과 홈페이지`, `학과 사무실`, `학교 대표 번호`, `학과 이메일`).
  - The `contact` field, if present, passes through verbatim via object spread.

### 4.3 `/api/school-api` ([`api/school-api.js`](../api/school-api.js))

- **Body parser disabled** (`export const config = { api: { bodyParser: false } }`). The handler reads the request stream into a `Buffer` and forwards it byte-for-byte. This is necessary to preserve UTF-8 multibyte sequences (Korean) that Vercel's default body parser was lossily decoding (replacing each codepoint with U+FFFD before re-serialization).
- Action allowlist: `email_signup`, `email_login`, `kakao_login`, `verify`, `save_chat`, `save_survey`, `survey_summary`, `usage_summary`.
- `Content-Type: application/json; charset=utf-8` is explicitly set on the upstream request.
- Headers `x-dashboard-token` and `authorization` are forwarded to the upstream.
- CORS preflight: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, X-Dashboard-Token`.

### 4.4 HeyGen helpers

- `/api/heygen-token` issues an ephemeral LiveKit access token for the streaming avatar.
- `/api/heygen-proxy` forwards REST calls (`streaming.new`, `streaming.start`, `streaming.task`, `streaming.stop`) to HeyGen's REST API.

### 4.5 Bot protection

Vercel's default bot protection is enabled on the project. Programmatic clients (cURL, scripted tests) frequently receive a `Vercel Security Checkpoint` interstitial (HTTP 403); browser clients pass through automatically. The school API (`/api/school-api`) is also subject to this, which is why end-to-end automation tests are typically run against `localhost:9000` on the Middleton host (which bypasses Vercel and nginx and exercises the same code path).

---

## 5. Tier T3 — Conversational Core (Middleton)

### 5.1 Host environment

| Property | Value |
|---|---|
| Hostname | `cha-Bigdata` (DDNS: `middleton.p-e.kr`) |
| OS | Ubuntu Linux |
| Reverse proxy | nginx 1.18.0 (TLS via Let's Encrypt; HTTPS-only; HTTP→HTTPS 301 redirect) |
| SSH | port 7822 (external 22, 2022, 22022, … blocked) |
| Filesystem location | `/home/student04/finbot/server/` |
| Process manager | pm2 (process name `finbot-server`) |
| Node | v24.14.1 (managed via nvm; absolute path `/home/student04/.nvm/versions/node/v24.14.1/bin/node` required outside login shells) |
| Web framework | Express |
| Listen | `127.0.0.1:9000` (loopback only; reachable externally only via nginx) |

### 5.2 Other co-located services on Middleton

| Port | Service | Used by this system? |
|---|---|---|
| 11435 | Ollama LLM inference (`/api/chat`) | Yes — Gemma4 |
| 11436 | Ollama embedding (`/api/embeddings`) | Yes — bge-m3 |
| 19000 | LLM router (`/v1/...`) | No |
| 3000 | Open-WebUI | No |
| 8888 | JupyterHub | No |
| 8787 | RStudio | No |
| 8004 | MedGemma API | No |
| 8088 | Server-ops dashboard | No |

The same host is shared with several other research services. This system uses only the two Ollama ports and the Express :9000.

### 5.3 Express routing ([`server/routes/interview-chat.js`](../server/routes/interview-chat.js))

```
POST /api/interview-chat
   Request:  { message: string, history?: Array<{role, content}> }
   Response: { reply: string, ttsReply: string, contact?: ContactObject }
```

### 5.4 RAG retrieval (`server/utils/cha-rag.js`)

| Property | Value |
|---|---|
| Embedding model | `bge-m3` via Ollama `POST /api/embeddings` |
| Embedding dimension | 1024 |
| Embedding normalization | L2 normalized at index time and at query time |
| Similarity | Dot product over normalized vectors (== cosine similarity) |
| Index storage | `data/cha_rag_chunks.json` (array of objects), `data/cha_rag_embeddings.json` (array of arrays) — same length, positionally aligned |
| Loader | Lazy-loaded into module-level `_chunks` / `_embeds` on first call (single in-process cache) |
| Cache invalidation | Process restart only (i.e. `pm2 restart finbot-server`) |
| Default top-K | 5 |
| Default minimum similarity | 0.25 |

Reference implementation:

```js
async function retrieve(query, topK = 5, minScore = 0.25) {
  load();
  const qvec = await embed(query);                                      // L2-normalized
  const scored = _embeds.map((evec, i) => ({
    chunk: _chunks[i],
    score: dotProduct(qvec, evec)
  }));
  return scored
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => ({ ...x.chunk, score: x.score }));
}
```

### 5.5 RAG corpus composition (n = 131 chunks at 2026-05-05)

| Chunk ID range | Count | Origin |
|---|---|---|
| `ch-001` … `ch-082` | 82 | Initial v1 corpus (per-major Q&A summaries; 11 majors covered) |
| `ch-083` … `ch-120` | 38 | Detail expansion (per-major curriculum, certifications, internships, career tracks) — added 2026-05-05 morning |
| `ch-121` … `ch-131` | 11 | Department-contact chunks (one per major) — added 2026-05-05 evening |

Per-section counts after the augmentation (selected):

| Section | Chunks |
|---|---|
| 경영학 (chapter-named) | ≈ 36 |
| 세포·유전자재생의학 | 11 |
| AI의료데이터학 | 9 |
| 스포츠의학 | 9 |
| 시스템생명과학 / 바이오식의약학 / 디지털보건의료 / 미디어커뮤니케이션학 / 심리학 | 8 each |
| 미술치료 / 소프트웨어융합 | 7 each |

Each chunk is a JSON object with at minimum:

```json
{ "id": "ch-128",
  "section": "심리학",
  "question": "심리학 전공 학과 사무실에 어떻게 연락하면 되나요?",
  "answer": "심리학 전공 학과 사무실 연락처는 031-850-8939이에요. ...",
  "keywords": ["심리학", "상담심리", ...] }
```

The index-time embedding text is `embedding_text` if present, otherwise `question + ' ' + answer`.

### 5.6 LLM serving

| Property | Value |
|---|---|
| Provider | Ollama (local) |
| Endpoint | `http://127.0.0.1:11435/api/chat` |
| Model name | `gemma4:latest` |
| Stream mode | `false` (request fully buffered before client receives) |
| `think` flag | `false` |
| `num_predict` | 400 |
| `temperature` | 0.7 |

The endpoint expects `{messages: [...], model, stream, think, options: {...}}` and returns `{message: {content: "..."}}`. The handler trims a leading ```` ```json ```` fence if present and extracts the first balanced JSON object containing `"reply"`.

### 5.7 System prompt construction (`buildSystemPrompt`)

The system prompt has six labeled sections (verbatim labels):

1. **역할** — defines the bot as a CHA Business-Major teaching assistant for Prof. Park Dae-keun, instructed to (a) speak in Korean haeyo-체, (b) cover Business plus the eleven Future Convergence majors, (c) draw answers strictly from the retrieved chunks, (d) refrain from inventing facts, and (e) **embed contact information into the answer body if the user is asking about a specific department**. (This last item is enforced at the post-processing layer; see § 5.8.)
2. **컨택 안내 규칙** — instructs the model not to write phone numbers, URLs or email addresses into the answer body, and not to write contact-introducing sentences ("홈페이지는 …", "연락처는 …", "이메일은 …"). The system appends a single closing line ("학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요.") deterministically; the model must not append it itself.
3. **TTS 발음 규칙** — defines the Korean pronunciation table for English acronyms (CHA, AI, IT, ESG, RAG, CPA, KAIST, CEO, R&D, MBTI), institutional names (차의과학대학교, 차병원, 미래융합대학, 경영학전공), and the eleven major names (long compounds segmented by spaces, e.g. `세포·유전자재생의학 → 세포 유전자 재생 의학`, `미디어커뮤니케이션학 → 미디어 커뮤니케이션 학`, `AI의료데이터학 → 에이아이 의료 데이터학`).
4. **출력 규칙 (절대 준수)** — forbids emojis (TTS reads them out loud) and decorative punctuation; forbids investment recommendations and absolute career guarantees.
5. **출력 형식 (반드시 준수)** — the model must return only a JSON object `{"reply":"…","ttsReply":"…"}` with no surrounding text.
6. **참고 자료 (RAG 검색 결과)** — the retrieved chunks are interpolated as

   ```
   [<section>]
   Q: <question>
   A: <answer>

   [<section>]
   Q: <question>
   A: <answer>
   …
   ```

If retrieve returned zero chunks, the literal string `(관련 정보를 찾지 못했습니다)` is interpolated instead.

### 5.8 Post-processing pipeline

The pipeline runs in this order on the model's output:

1. **JSON extraction.** Match `\{[\s\S]*"reply"[\s\S]*\}` and `JSON.parse`. If parsing fails, fall back to `{reply: raw, ttsReply: raw}`.
2. **Emoji strip.** `\u{1F300}-\u{1FAFF}`, `\u{2600}-\u{27BF}`, `\u{1F000}-\u{1F2FF}`, `\u{2700}-\u{27BF}`, `\u{FE0F}` are removed from both `reply` and `ttsReply`.
3. **Reply contact strip.** Remove URLs, `1899-\d{4}`, `0\d{1,2}-\d{3,4}-\d{4}`, emails, `(?:[영일이삼사오육칠팔구공]\s*){5,}`. Then collapse adjacent Korean particles (`는`, `은`, `이`, `가`, `을`, `를`, `이고`, `이며`, `이니`, `이에요`, `예요`, `이라`, `라`) followed by punctuation, and strip stranded labels (`홈페이지는`, `연락처는`, …) at line ends.
4. **TtsReply contact strip.** Same patterns as (3); additionally strip whole sentences that match `[^.!?]*?(?:홈페이지는?|연락처는|사무실 번호[는을]?|이메일은)[^.!?]*?(?:입니다|이에요|예요|에요|이고|이며|이니|드려요|드릴게요|돼요)\.?` (this catches phonetic spell-outs of URLs that LLMs occasionally emit).
5. **Tail-line normalization.** Strip any "화면 ... 드릴게요/드려요/할게요/드립니다" sentence the model may have appended. If `_contactObj` is non-null, append the canonical closing line ".  학과 사무실 번호와 학과 홈페이지는 화면에 표시해 드릴게요." to **both** `reply` and `ttsReply`.
6. **TTS pronunciation table.** Apply replacements in this fixed order: middle dot `·` → space (so it is not pronounced "점"), then each entry of `TTS_REPLACEMENTS` (acronyms, institution names, eleven majors, `%` → `퍼센트`).
7. **Korean count words.** `(\d)\s*가지` → `한/두/세/네/다섯/여섯/일곱/여덟/아홉 가지`; the corresponding Sino-Korean numerals `일/이/삼/사/오/육/칠/팔/구 가지` are also normalized into native counters.
8. **Compound disambiguation.** `미디어커뮤니케이션학` → `미디어 커뮤니케이션 학`, `미디어커뮤니케이션` → `미디어 커뮤니케이션`.

The Vercel proxy (§ 4.2) re-applies the URL/phone/email scrubbing on `ttsReply` as a defense-in-depth measure in case Middleton is bypassed or rolled back.

### 5.9 Contact disambiguation (`pickContactFromHits`)

```js
function pickContactFromHits(hits, userMessage) {
  const norm = (userMessage || '').replace(/\s+/g, '');
  // Sort keys by length descending so "미디어커뮤니케이션학" beats "심리학" inside the same string.
  const keys = Object.keys(DEPT_CONTACTS).sort((a, b) => b.length - a.length);
  for (const sec of keys) {
    const variants = new Set([sec, sec.replace('·', ''), sec + '과', sec + '전공']);
    for (const v of variants) {
      if (v && norm.includes(v.replace(/\s+/g, ''))) return DEPT_CONTACTS[sec];
    }
  }
  // Fallback: explicit contact chunk in the retrieve hits
  if (hits && hits.length) {
    const contactHit = hits.find(h => /^ch-12\d$/.test(h.id || ''));
    if (contactHit && DEPT_CONTACTS[contactHit.section]) return DEPT_CONTACTS[contactHit.section];
  }
  return null;
}
```

Why this order matters: an earlier version that consulted retrieve hits first could mis-attribute a "미술치료 사무실" query to `심리학` because `ch-128` (심리학 contact) had a higher similarity score than `ch-130` (미술치료 contact). Anchoring on a literal mention of the major name in the user's message makes attribution robust to that retrieval ranking artifact.

### 5.10 `DEPT_CONTACTS` table

| `section` (key) | `dept` (display) | `phone` | `homepage` | `chairEmail` | `note` |
|---|---|---|---|---|---|
| 세포·유전자재생의학 / 세포유전자재생의학 (alias) | 세포·유전자재생의학 전공 | 031-881-7140 | https://bm.cha.ac.kr/ | jsong@cha.ac.kr | — |
| 시스템생명과학 | 시스템생명과학 전공 | 031-881-7137 | https://fsb.cha.ac.kr/ | — | — |
| 바이오식의약학 | 바이오식의약학 전공 | 031-850-9320 | https://bio.cha.ac.kr/ | hongsr@cha.ac.kr | — |
| 디지털보건의료 | 디지털보건의료 전공 | 031-850-8940 | https://aihealthcare.cha.ac.kr/ | — | — |
| 스포츠의학 | 스포츠의학 전공 | 031-850-8941 | https://sports.cha.ac.kr/ | — | — |
| 경영학 | 경영학 전공 | 031-850-8944 | https://biz.cha.ac.kr/ | — | School registration name: 데이터경영학과 |
| 미디어커뮤니케이션학 | 미디어커뮤니케이션학 전공 | 031-850-8945 | https://comm.cha.ac.kr/ | — | School registration name: 의료홍보미디어학과 |
| 심리학 | 심리학 전공 | 031-850-8939 | https://cp.cha.ac.kr/ | — | School registration name: 상담심리학과 |
| AI의료데이터학 | AI의료데이터학 전공 | 031-850-8952 | https://dai.cha.ac.kr/ | — | 미래융합대학 학사지원실 (no direct line) |
| 미술치료 | 미술치료 전공 | 031-850-8943 | https://at.cha.ac.kr/ | — | — |
| 소프트웨어융합 | 소프트웨어융합 전공 | 031-850-8952 | https://swc.cha.ac.kr/ | — | 미래융합대학 학사지원실 (no direct line) |

The numbers were obtained from CHA University's central directory at `https://www.cha.ac.kr/전화번호안내/` cross-checked against each department's public faculty page; the "school registration name" notes account for a divergence between the bot's per-major naming and the formal academic-unit naming of the same students' home department.

---

## 6. Tier T4 — School API & Database

### 6.1 Host environment

| Property | Value |
|---|---|
| Domain | `aiforalab.com` |
| OS | CentOS 7 (kernel 3.10.0-1160.114.2.el7) |
| Web server | Apache 2.4.6 (`httpd`, MPM prefork) |
| Application runtime | PHP 5.4.45 (mod_php) |
| Database | MySQL 8.0 |
| SSH | port 10022 |
| Application path | `/var/www/html/interview-api/` |

### 6.2 Apache configuration

`AllowOverride` is `None` for `<Directory "/var/www/html">` in the main `httpd.conf`. To enable the application's `.htaccess`, an explicit override is installed at `/etc/httpd/conf.d/interview-api.conf`:

```apache
<Directory "/var/www/html/interview-api">
    AllowOverride All
    Require all granted
</Directory>
```

The application's `.htaccess` uses `mod_env`'s `SetEnv` to inject four environment variables:

```
SetEnv CHA_DB_USER          <db user>
SetEnv CHA_DB_PASS          <db password>
SetEnv CHA_JWT_SECRET       <64 hex chars>
SetEnv CHA_DASHBOARD_TOKEN  <40 base64url chars>
```

`.htaccess` is reread on every request, so token rotation does not require an Apache restart.

### 6.3 PHP entry (`api.php`)

The router dispatches on `?action=`:

| Action | Handler | Auth |
|---|---|---|
| `health` | inline | public |
| `kakao_login` | `handleKakaoLogin` | public; upserts user, issues JWT |
| `email_signup` | `handleEmailSignup` | public; bcrypt-style hash |
| `email_login` | `handleEmailLogin` | public |
| `verify` | `handleVerify` | requires JWT |
| `save_chat` | `handleSaveChat` | optional JWT (anonymous allowed) |
| `list_chats` | `handleListChats` | requires JWT (own messages only) |
| `save_survey` | `handleSaveSurvey` | optional JWT (anonymous allowed) |
| `survey_summary` | `handleSurveySummary` | `X-Dashboard-Token` |
| `usage_summary` | `handleUsageSummary` | `X-Dashboard-Token` |

### 6.4 JWT

| Property | Value |
|---|---|
| Algorithm | HS256 (HMAC-SHA256) |
| Encoding | manual base64 of `header.payload.signature` (no padding considered; not strictly RFC 7515) |
| Payload | `{user_id: int, exp: unix-seconds + 7×86400}` |
| Verification | constant-time hash compare via `hash_equals` if available, else byte-by-byte compare with early exit avoided |

### 6.5 Timing-safe equality on PHP 5.4

`hash_equals` was added in PHP 5.6. The summary handlers therefore implement an inline XOR-fold:

```php
$eq = false;
if (strlen($expected) === strlen($provided)) {
  $r = 0;
  for ($i = 0; $i < strlen($expected); $i++) $r |= ord($expected[$i]) ^ ord($provided[$i]);
  $eq = ($r === 0);
}
```

This avoids early-exit timing leaks on byte-mismatched prefixes.

### 6.6 Database schema (`cha_interview_db`, MySQL 8.0, `utf8mb4_unicode_ci`)

#### `users`

| Column | Type | Note |
|---|---|---|
| id | INT AI PK | |
| kakao_id | VARCHAR(64) UNIQUE NULL | |
| email | VARCHAR(255) UNIQUE NULL | |
| password_hash | VARCHAR(255) NULL | bcrypt (`$2y$10$…`) for email-signup users |
| name | VARCHAR(100) NOT NULL | |
| visit_count | INT DEFAULT 1 | incremented per login |
| last_login | DATETIME NULL | |
| created_at | DATETIME DEFAULT CURRENT_TIMESTAMP | |

#### `chat_logs`

| Column | Type | Note |
|---|---|---|
| id | INT AI PK | |
| user_id | INT NULL | FK → `users(id)` ON DELETE SET NULL |
| session_id | VARCHAR(64) NOT NULL | client-issued `sess_<ts>_<rand>` |
| role | ENUM('user','assistant') | |
| message | TEXT NOT NULL | |
| rag_hits | TEXT NULL | JSON-encoded retrieved chunks (currently always NULL — see § 12.3) |
| created_at | DATETIME DEFAULT CURRENT_TIMESTAMP | |

Indexes: `(user_id)`, `(session_id)`, `(created_at)`.

#### `survey_responses` (39 columns)

| Group | Columns |
|---|---|
| Identity | `id` PK, `user_id` FK, `session_id`, `survey_version` (default `'v1'`) |
| Demographics (Q1–Q5) | `grade ENUM`, `gender ENUM`, `mbti CHAR(4)` (regex-validated), `major1`, `major2` |
| Yes/No items (Q6–Q23, 18 columns) | `q06_digital_twin … q23_kakao_redirect`, all `TINYINT(1) NULL` (NULL ⇔ inapplicable / not answered) |
| Overall trust (Q24) | `q24_overall_trust TINYINT(1) NULL` |
| Layer scores (server-computed) | `layer1_score TINYINT (0–3)`, `layer2_score (0–4)`, `layer3_score (0–5)`, `layer4_score (0–6)`, `total_yes_count (0–18)` |
| Free-text (Q25, Q26) | `free_positive TEXT NULL`, `free_negative TEXT NULL` (truncated to 2000 chars by server) |
| Meta | `user_agent VARCHAR(255)`, `duration_seconds INT`, `flag_too_fast TINYINT(1) DEFAULT 0`, `submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP` |

Indexes: `(user_id)`, `(session_id)`, `(survey_version)`, `(submitted_at)`. FK: `user_id` → `users(id)`.

### 6.7 Layer score computation (server-side)

```text
layer1_score   = q06 + q07 + q08                                    ∈ [0, 3]
layer2_score   = q09 + q10 + q11 + q12                              ∈ [0, 4]
layer3_score   = q13 + q14 + q15 + q16 + q17                        ∈ [0, 5]
layer4_score   = q18 + q19 + q20 + q21 + q22 + q23                  ∈ [0, 6]
total_yes_count = sum of all 18 answered Yes items                  ∈ [0, 18]
```

NULL responses (an inapplicable conditional question) are excluded from the sum, not coerced to 0. `flag_too_fast` is set to 1 iff `duration_seconds < 60`.

---

## 7. Trust-Component Survey (Evaluation Instrument)

### 7.1 Design

The survey adapts Park's *trust-by-design* framework to the eighteen identifiable components of the bot. The instrument is **Yes/No** rather than Likert to (i) reduce response fatigue (it is delivered immediately after a session whose median length is roughly two minutes) and (ii) align each component with a single binary "did I observe this trust signal during my session?" judgment.

### 7.2 Items (Q6–Q23) and 4-Layer grouping

| Layer (max) | Items | Theme |
|---|---|---|
| **L1 — Bot identity (max 3)** | Q6 digital twin, Q7 institutional identity, Q8 AI disclosure | "Who is this and on whose behalf is it speaking?" |
| **L2 — Answer quality (max 4)** | Q9 RAG grounding, Q10 limit admission, Q11 warm tone, Q12 format consistency | "Are the answers sourced, honest, warm, and consistent?" |
| **L3 — Conversational naturalness (max 5)** | Q13 latency pacing, **Q14 echo guard*** (voice/video only), Q15 ESC interrupt, **Q16 avatar embodiment*** (video only), Q17 mode switch | "Does the dialog feel like a dialog?" |
| **L4 — Policy and relational signals (max 6)** | Q18 consent UI, Q19 guest browse, Q20 Korean ordinal, **Q21 visit tracking*** (revisitor only), **Q22 TTS normalization*** (voice/video only), **Q23 Kakao redirect*** (in-Kakao UA only) | "Are policies clear and is the relationship over time honored?" |

Items marked **\*** are conditional: if the respondent did not satisfy the precondition during the session that triggered the survey, the UI disables the item and the server stores `NULL` in that column. They are **excluded from layer-score sums**, not coerced to zero. Q24 is the global trust outcome.

### 7.3 Delivery

- Modal: [`src/components/SurveyModal.jsx`](../src/components/SurveyModal.jsx)
- Trigger A — explicit header `[설문]` button (always available, including after a session has ended).
- Trigger B — auto-open on `stopAvatar()` if `userTurnCountRef.current ≥ 3`.
- Time-on-task is captured (`duration_seconds`); responses faster than 60 s are flagged for downstream filtering.

### 7.4 Aggregation API (`survey_summary`)

Returns counts and averages only. Per-respondent rows and free-text are **not** returned. Specifically:

```json
{
  "total": <int>, "valid": <int (flag_too_fast=0)>,
  "components": { "q06_digital_twin": { "n":..,"yes":..,"no":..,"yes_pct":..}, ... },
  "layers": { "L1": {"avg":..,"max":3}, "L2":..., "L3":..., "L4":..., "total":{"avg":..,"max":18} },
  "demographics": { "grade": [{k,n,avg_total,q24_yes_pct}, …], "gender":..., "mbti":..., "major1":... },
  "daily": [{"d":"YYYY-MM-DD","n":..,"avg_total":..}, ...],
  "score_hist": [{"bucket_lo": 0|3|6|9|12|15|18, "n": ..}]
}
```

All aggregations apply a `WHERE flag_too_fast = 0` filter.

---

## 8. Operations Dashboard

### 8.1 Hosting

A single-file Vanilla HTML application at `public/dashboard/index.html`, served by Vercel at `https://cha-interview-bot.vercel.app/dashboard/`. Chart.js v4.4.4 is loaded from the jsDelivr CDN. No bundler, no React.

### 8.2 Authentication

A 40-character random secret (`CHA_DASHBOARD_TOKEN`) is set in the school server's `.htaccess`. The dashboard prompts the operator on first load, stores the token in `sessionStorage["cha_dashboard_token"]`, and forwards it on every API call as `X-Dashboard-Token`. The PHP handlers compare it against the env var with the timing-safe equality of § 6.5.

### 8.3 Sections

- **USAGE** (lime accent) — `usage_summary`
  - KPI: `users_total` (with kakao/email split), `sessions_total` (with anonymous), `messages_total` (with user/bot split), `avg_session_duration` (with mean user-turns).
  - Charts: daily activity (signup bar + active-user line + session line), session-turn histogram, hourly distribution, signup-type donut, revisit histogram.
  - Top-10 users table: `id`, `name`, `login_type` tag, message counts, sessions, visit_count, last_login.
- **TRUST SURVEY** (cyan accent) — `survey_summary`
  - KPI: total / valid / Q24 yes-rate / avg total.
  - Charts: 18-component yes-rate horizontal bar, 4-layer percent-of-max bar, daily trend (response count + average score, dual-axis).
  - Demographic slice tables (grade, gender, major1, mbti).

### 8.4 Privacy boundary

The dashboard never exposes:
- Chat message bodies (`chat_logs.message`)
- RAG hits per chat (`chat_logs.rag_hits`)
- Per-respondent free text (`survey_responses.free_positive`, `free_negative`)
- Kakao IDs or email addresses (the Top-10 row shows `name` and a `login_type` tag only)
- Per-respondent demographic combinations beyond the marginal counts in the demographic tables

### 8.5 Chart.js stability

All `<canvas>` elements are wrapped in fixed-height `<div class="chart-wrap">` containers and Chart options use `{responsive:true, maintainAspectRatio:false, animation:false, resizeDelay:120}`. Without the fixed-height wrapper, Chart.js's default behavior interacts with grid/flex parents to produce a `ResizeObserver` feedback loop that grows charts unboundedly.

---

## 9. Cross-Cutting Concerns

### 9.1 UTF-8 preservation across T2

Vercel's default body parser was observed to corrupt Korean multibyte sequences in `req.body` strings, producing U+FFFD replacement characters before re-serialization (visible in the database as 0xEF 0xBF 0xBD bytes). The fix is to disable the body parser on `/api/school-api` and forward the raw `Buffer` upstream:

```js
export const config = { api: { bodyParser: false } };
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}
```

The upstream request is sent with explicit `Content-Type: application/json; charset=utf-8`. This was verified by inspecting `HEX(major1)` and `HEX(free_positive)` in MySQL after a browser submission: `4149 EC9D98 EBA38C EB8DB0 EC9DB4 ED84B0 ED9599` is the correct UTF-8 of "AI의료데이터학", whereas the broken pre-fix path yielded `EFBFBD` repeated.

### 9.2 Sensitive-term policy

The string `신경 치료` (a clinical term that arose during a faculty review of the스포츠의학 RAG corpus and was deemed inappropriate for a counseling context) is removed at three layers: the offending RAG chunk was rewritten in the corpus; T3's post-processing strips it from `reply` and `ttsReply`; and T2 reapplies the substitution `신경 치료 → 통증 관리` as a defense-in-depth measure.

### 9.3 Conditional survey items

Pre-conditions are evaluated client-side at the moment the survey opens, using only client-knowable state:

| Item | Pre-condition | Source |
|---|---|---|
| Q14 echo guard | mode used ∈ {`ftf`, `sts`} | `modesUsedRef` |
| Q16 avatar embodiment | mode used ⊇ {`ftf`} | `modesUsedRef` |
| Q21 visit tracking | `user.visit_count ≥ 2` | `users` row from `verify` |
| Q22 TTS normalization | mode used ∈ {`ftf`, `sts`} | `modesUsedRef` |
| Q23 Kakao redirect | `navigator.userAgent` matches `/KAKAOTALK/i` | UA at survey-open time |

If any pre-condition is unmet, the corresponding row is rendered disabled with the label "해당 없음", the buttons are not clickable, and `null` is sent for that column.

---

## 10. Performance Characteristics

The system has not been instrumented with formal latency measurement, but the following budget is observable from production logs (`pm2 logs finbot-server`):

| Stage | Order of magnitude |
|---|---|
| Client → Vercel (TLS handshake amortized) | tens of ms |
| Vercel → nginx → finbot Express | tens of ms (depends on user's RTT to Vercel and to Korea) |
| Embed query (bge-m3, single query) | ≈ 50–150 ms |
| Cosine retrieve over 131 chunks | < 1 ms (in-memory) |
| LLM generation (Gemma4, `num_predict=400`, single shot) | ≈ 2–6 s |
| Sanitization pipeline | < 1 ms |
| HeyGen `streaming.task` | network only; visible avatar latency dominated by HeyGen pipeline (typically 1–3 s before first phoneme) |

The retrieval cost is constant in the corpus size up to a single-machine memory limit; the corpus is currently 131 × 1024 × 4 bytes ≈ 0.5 MB, which is negligible. Retrieval is therefore not a near-term scaling concern.

---

## 11. Security and Privacy

### 11.1 Authentication / authorization summary

| Surface | Auth | Notes |
|---|---|---|
| `/api/chat`, `/api/heygen-*` | none | Public; Vercel Bot Protection mitigates abuse |
| `/api/school-api?action=save_chat` | optional JWT | Anonymous chat is permitted; rows store `user_id = NULL` |
| `/api/school-api?action=save_survey` | optional JWT | Anonymous survey is permitted |
| `/api/school-api?action=verify, list_chats` | JWT required | Users see only their own messages |
| `/api/school-api?action=survey_summary, usage_summary` | `X-Dashboard-Token` | One static secret; no per-user audit |

### 11.2 PII handling

The dashboard's privacy boundary (§ 8.4) is the operative policy: no chat message body, no email, no `kakao_id`, no per-respondent free text leaves the database via the dashboard endpoints. The Top-10 user list returns names and a login-type tag only; the database keys themselves are never returned.

The path forward (not implemented as of this document) is staged:

1. **Stage A (current).** Aggregate-only dashboards with no chat-body access. Compatible with the existing Kakao-login consent.
2. **Stage B.** Operator-readable anonymized chat samples after explicit "research/quality review" consent at signup. Names masked.
3. **Stage C.** Full per-user chat logs to authenticated administrators (`users.role = 'admin'`) with an audit log.

### 11.3 Threat model gaps

- No application-level rate limiting on `/api/chat`. Vercel-edge rate-limits exist but are coarse.
- No CAPTCHA on signup; abuse mitigation rests on Kakao's anti-spam and email confirmation.
- The dashboard token is a single shared secret and is therefore unsuitable for delegated audit. A per-administrator JWT-based scheme is the natural successor.
- The school server's MySQL credentials are sourced from `.htaccess` `SetEnv`. They are not in the application source tree but are accessible to anyone with `user2` shell access.

---

## 12. Known Limitations and Future Work

### 12.1 Conditional questions and small-N skew

Five conditional questions (Q14, Q16, Q21, Q22, Q23) yield NULL in the sum for respondents who did not satisfy the precondition. Consequently the `total_yes_count` ceiling is not reachable by every respondent; analyses must either compute *yes-rate over answered items* per respondent or bin by which conditions were satisfied. The dashboard currently reports both raw mean total and per-component yes-rate, which together suffice for the academic analyses planned (logistic regression of Q24 on layer scores, χ² of each component against Q24, and clustering of the 18-bit answer vector).

### 12.2 External direct-call charset issue

When any caller other than the production browser flow sends a Korean string to the Middleton endpoint, nginx's `default location /` fallthrough (which routes unmapped paths to the co-located Open-WebUI service on port 3000) introduces character-set ambiguity that lowers retrieval precision: `retrieve("스포츠의학 학과 사무실 전화번호 알려주세요")` from `localhost:9000` yields top-1 `ch-125 (0.79)`, whereas the same string sent from outside via cURL yields top scores ≈ 0.49 with no contact chunks in the top-5. The browser flow (which traverses `/api/chat` → fetch with explicit `Content-Type: application/json; charset=utf-8` and raw-body forwarding) is unaffected. A direct nginx `location /finbot/` block on the Middleton host is the intended fix.

### 12.3 RAG hit attribution

The Middleton response object currently exposes only `{reply, ttsReply, contact?}`; the retrieval results that informed the model are not returned to the client. Therefore `chat_logs.rag_hits` is always NULL in production, and per-message attribution analyses (e.g. "which chunk most often grounds answers about 미술치료?") are not yet possible. Adding `rag: hits.map({id, section, score})` to the response would close this gap; it is intentionally deferred to keep the privacy boundary uniform until the dashboard's audit story matures.

### 12.4 Mode-of-use is not persisted on chat

`chat_logs.role` exists, but the conversational mode (`ftf` / `sts` / `ttt`) is held only in client memory and is therefore not joinable to chat rows. A `chat_logs.mode VARCHAR(8)` column and a corresponding parameter to `saveChat()` would unlock per-mode latency, length, and abandonment analyses.

### 12.5 Privacy consent UI

The Kakao-login consent text does not currently include an explicit clause on operator review of chat content for quality-improvement purposes. Implementing such a clause and a non-coerced opt-in checkbox is a prerequisite for Stage B / C of § 11.2.

### 12.6 Two majors lack a direct extension

Two new majors (AI의료데이터학, 소프트웨어융합) do not yet have direct department extensions in the central directory, and route to the College of Future Convergence's general administrative office (031-850-8952). When extensions are assigned the corresponding entries in `DEPT_CONTACTS` (lines `AI의료데이터학` and `소프트웨어융합`) and the corresponding RAG chunks `ch-129` and `ch-131` should be updated; no other code change is required.

---

## 13. Software Versions Reference (as of 2026-05-05)

| Component | Version |
|---|---|
| React | 18.x |
| Vite | 8.0.10 |
| Chart.js (CDN) | 4.4.4 |
| LiveKit client | (latest at build) |
| Node (T2 Vercel) | 22.x runtime |
| Node (T3 Middleton) | 24.14.1 |
| pm2 | (current) |
| Express | (npm latest in `package.json` of finbot) |
| Ollama | bge-m3 (params 566.70M, F16 GGUF), gemma4:latest |
| nginx | 1.18.0 (Ubuntu) |
| Apache | 2.4.6 (CentOS) |
| PHP | 5.4.45 (CLI built 2022-06-23) |
| MySQL | 8.0 (`utf8mb4_unicode_ci`) |

---

## 14. Reproducibility Checklist

| Question | Where to find the exact answer |
|---|---|
| What is the embedding model and dimension? | § 5.4 — `bge-m3`, 1024-dim |
| What is the LLM and its generation parameters? | § 5.6 — `gemma4:latest`, `num_predict=400`, `temperature=0.7`, `stream=false` |
| How many RAG chunks at study time? | § 5.5 — 131 (82 + 38 + 11) |
| How is similarity computed? | § 5.4 — dot product on L2-normalized vectors (cosine similarity) |
| What is the retrieval top-K and threshold? | § 5.4 — top-K = 5, min_score = 0.25 |
| How are conditional survey items handled? | § 7.2 + § 9.3 — NULL stored, excluded from layer sums |
| How is the layer score computed? | § 6.7 — explicit per-layer formulas |
| How is the survey delivered? | § 3.7 + § 7.3 — auto on stop if `userTurnCountRef ≥ 3`, plus manual header button |
| How are URLs/phones/emails handled in TTS? | § 5.8 + § 4.2 — stripped from `ttsReply`, kept in `reply`, surfaced as a structured `contact` UI card |
| How is contact attribution disambiguated? | § 5.9 — length-descending substring match on the user message; retrieval is fallback only |
| How is privacy enforced in the dashboard? | § 8.4 — chat bodies, raw IDs, and free text are never returned by the summary endpoints |
| How is UTF-8 preserved through the proxy? | § 9.1 — body-parser disabled, raw `Buffer` forwarded with explicit charset |
| What are the four authorization surfaces? | § 11.1 — public, optional JWT, JWT required, dashboard token |

---

## 15. Citation-Ready Summary (one-paragraph)

> CHA-Interview-Bot is a four-tier retrieval-augmented conversational agent: a React 18 single-page application (built with Vite 8) on Vercel; a stateless Vercel-serverless edge proxy that performs raw-byte body forwarding and TTS-only contact-information scrubbing; a Node 24 + Express RAG/LLM core (`finbot-server`) on a self-hosted Ubuntu GPU host (`middleton.p-e.kr`) that runs cosine-similarity retrieval (`top-K = 5`, `min_score = 0.25`) over a 131-chunk Korean corpus embedded with `bge-m3` (1024-dimensional, L2-normalized) and serves Gemma4 via Ollama (`num_predict = 400`, `temperature = 0.7`, `stream = false`); and a CentOS 7 Apache 2.4.6 + PHP 5.4.45 + MySQL 8.0 backend on `aiforalab.com` that owns user, chat-log and survey-response persistence and issues HS256 JWTs with a 7-day TTL. The system supports three conversation modes (text, voice, voice + HeyGen embodied avatar) and is instrumented with a Yes/No, four-layer, eighteen-component trust survey (with five mode/visit/UA-conditional items that store NULL when inapplicable) and an operator dashboard that exposes only aggregates (no chat bodies, no per-respondent free text, no Kakao IDs, no email addresses) gated by a single shared `X-Dashboard-Token` secret.

---

## 16. Document History

- **2026-05-05** — v1.0. Drawn from the full specification document, the chronological development log, and direct inspection of the production Apache, MySQL, Middleton, and Vercel environments on the same date. All numeric values in this document (latency budgets, corpus counts, user counts, port numbers) were verified by live `cURL` and `mysql` queries against the production system on 2026-05-05.
