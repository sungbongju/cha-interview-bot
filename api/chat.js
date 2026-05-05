// 면담봇 채팅 — Middleton RAG+Gemma4 프록시

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const response = await fetch('https://middleton.p-e.kr/finbot/api/interview-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history })
    });
    const data = await response.json();
    return res.status(200).json(sanitizeResponse(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function sanitizeResponse(data) {
  if (!data || typeof data !== 'object') return data;

  const replaceSensitiveTerms = (text) => {
    if (typeof text !== 'string') return text;
    return text
      .replace(/신경\s*치료/g, '통증 관리')
      .replace(/\s+/g, ' ')
      .trim();
  };

  return {
    ...data,
    reply: replaceSensitiveTerms(data.reply),
    ttsReply: replaceSensitiveTerms(data.ttsReply)
  };
}
