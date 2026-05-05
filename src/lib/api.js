// 학교 서버 PHP API 클라이언트 (cha_interview_db)
const API_BASE = '/api/school-api'

const TOKEN_KEY = 'cha_interview_token'
const USER_KEY  = 'cha_interview_user'
const SID_KEY   = 'cha_interview_sid'

export function getToken() { return localStorage.getItem(TOKEN_KEY) }
export function getUser()  {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { return null }
}
export function setAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY,  JSON.stringify(user))
}
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

// 새 세션 ID 발급 (아바타 시작할 때마다 새로)
export function newSessionId() {
  const sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
  localStorage.setItem(SID_KEY, sid)
  return sid
}
export function getSessionId() { return localStorage.getItem(SID_KEY) }

async function call(action, payload = {}) {
  const res = await fetch(`${API_BASE}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return res.json()
}

export async function emailSignup(email, password, name) {
  const r = await call('email_signup', { email, password, name })
  if (r.success) setAuth(r.token, r.user)
  return r
}

export async function emailLogin(email, password) {
  const r = await call('email_login', { email, password })
  if (r.success) setAuth(r.token, r.user)
  return r
}

export async function kakaoLogin(kakao_id, nickname, email) {
  const r = await call('kakao_login', { kakao_id, nickname, email })
  if (r.success) setAuth(r.token, r.user)
  return r
}

// Kakao SDK 호출 → 사용자 정보 받아 학교 서버로 로그인
export function startKakaoLogin() {
  return new Promise((resolve, reject) => {
    if (!window.Kakao || !window.Kakao.Auth) {
      reject(new Error('카카오 SDK가 로드되지 않았어요.'))
      return
    }
    try { window.Kakao.Auth.setAccessToken(null) } catch {}
    const timeout = setTimeout(() => reject(new Error('로그인 시간이 초과됐어요.')), 45000)
    window.Kakao.Auth.login({
      success: () => {
        clearTimeout(timeout)
        window.Kakao.API.request({
          url: '/v2/user/me',
          success: async (res) => {
            const nickname = res?.kakao_account?.profile?.nickname || '사용자'
            const kakaoId  = String(res.id)
            const email    = res?.kakao_account?.email || null
            try {
              const r = await kakaoLogin(kakaoId, nickname, email)
              if (r.success) resolve(r.user)
              else reject(new Error(r.error || '서버 로그인 실패'))
            } catch (e) { reject(e) }
          },
          fail: (err) => reject(new Error('카카오 사용자 정보를 가져오지 못했어요.'))
        })
      },
      fail: (err) => {
        clearTimeout(timeout)
        reject(new Error('카카오 로그인이 취소됐어요.'))
      }
    })
  })
}

export async function verifyToken() {
  const token = getToken()
  if (!token) return null
  const r = await call('verify', { token })
  if (!r.success) { clearAuth(); return null }
  localStorage.setItem(USER_KEY, JSON.stringify(r.user))
  return r.user
}

// fire-and-forget: 응답 안 기다림. 토큰 있으면 user_id 매핑, 없으면 익명
export function saveChat(session_id, role, message, rag_hits = null) {
  const token = getToken()
  const body = { session_id, role, message }
  if (rag_hits) body.rag_hits = rag_hits
  if (token)    body.token = token
  // fire-and-forget — UX 절대 막지 않음
  fetch(`${API_BASE}?action=save_chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true
  }).catch(() => {})
}

// 신뢰설계 컴포넌트 평가 설문 제출 (v1)
// answers: { grade, gender, mbti, major1, major2, q06_..., ..., q24_overall_trust, free_positive, free_negative, duration_seconds }
export async function saveSurvey(answers) {
  const token = getToken()
  const body = { ...answers, survey_version: 'v1' }
  if (token) body.token = token
  const r = await call('save_survey', body)
  return r
}
