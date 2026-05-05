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

  // TTS만 — 화면 표시(reply)는 URL/전화/이메일 그대로 두고,
  // 음성으로는 읽지 않도록 자연어 표현으로 치환한다.
  const stripContactsForTts = (text) => {
    if (typeof text !== 'string') return text;
    return text
      // URL 전체 (https?://, www.)
      .replace(/https?:\/\/[^\s)\]]+/gi, '학과 홈페이지')
      .replace(/\bwww\.[^\s)\]]+/gi, '학과 홈페이지')
      // 학교 대표 1899-XXXX
      .replace(/\b1899[-\s]?\d{4}\b/g, '학교 대표 번호')
      // 일반 한국 전화번호 (0XX-XXX(X)-XXXX)
      .replace(/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '학과 사무실')
      // 짧은 형 (XXX-XXXX)
      .replace(/\b\d{3,4}[-\s]?\d{4}\b/g, '학과 사무실')
      // 이메일 — 도메인까지 통째로
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '학과 이메일')
      // 괄호로 둘러싸인 빈 자리(원 문장이 "(URL)" 식이었을 때) 정리
      .replace(/\(\s*[)]\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  return {
    ...data,
    reply: replaceSensitiveTerms(data.reply),
    ttsReply: stripContactsForTts(replaceSensitiveTerms(data.ttsReply))
  };
}
