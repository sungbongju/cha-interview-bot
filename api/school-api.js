const SCHOOL_API_BASE = 'https://aiforalab.com/interview-api/api.php'
const ALLOWED_ACTIONS = new Set([
  'email_signup',
  'email_login',
  'kakao_login',
  'verify',
  'save_chat',
  'save_survey'
])

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })

  const action = String(req.query?.action || '')
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'invalid action' })
  }

  try {
    const upstream = await fetch(`${SCHOOL_API_BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    })

    const text = await upstream.text()
    res.status(upstream.status)

    try {
      return res.json(JSON.parse(text))
    } catch {
      return res.send(text)
    }
  } catch (e) {
    return res.status(502).json({ error: e.message || 'school api proxy failed' })
  }
}
