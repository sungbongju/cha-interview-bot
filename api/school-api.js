const SCHOOL_API_BASE = 'https://aiforalab.com/interview-api/api.php'
const ALLOWED_ACTIONS = new Set([
  'email_signup',
  'email_login',
  'kakao_login',
  'verify',
  'save_chat',
  'save_survey',
  'survey_summary',
  'usage_summary'
])

const FORWARD_HEADERS = ['x-dashboard-token', 'authorization']

// Disable Vercel's auto body parser so we can forward raw UTF-8 bytes intact.
// The default parser was decoding Korean UTF-8 with the wrong charset, replacing
// each multi-byte char with U+FFFD before re-encoding — corrupting the payload.
export const config = { api: { bodyParser: false } }

async function readRawBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dashboard-Token')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })

  const action = String(req.query?.action || '')
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'invalid action' })
  }

  try {
    const rawBody = await readRawBody(req)

    const fwdHeaders = { 'Content-Type': 'application/json; charset=utf-8' }
    for (const name of FORWARD_HEADERS) {
      const v = req.headers?.[name]
      if (v) fwdHeaders[name] = String(v)
    }

    const upstream = await fetch(`${SCHOOL_API_BASE}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: fwdHeaders,
      body: rawBody
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
