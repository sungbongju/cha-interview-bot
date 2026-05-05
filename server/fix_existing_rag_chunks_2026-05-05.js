const fs = require('fs');
const path = require('path');

const DATA_DIR = '/home/student04/finbot/server/data';
const CHUNKS_PATH = path.join(DATA_DIR, 'cha_rag_chunks.json');

const chunks = JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf8'));
const ts = Date.now();
fs.copyFileSync(CHUNKS_PATH, `${CHUNKS_PATH}.textfix.${ts}`);

const replacements = [
  {
    id: 'ch-052',
    from: /신경\s*치료 이후/g,
    to: '회복 이후',
  },
  {
    id: 'ch-079',
    from: /활생학·신음 실습/g,
    to: '발생학·생식의학 관련 실습',
  },
  {
    id: 'ch-082',
    from: /기업 단방/g,
    to: '기업 탐방',
  },
];

let changed = 0;

for (const replacement of replacements) {
  const chunk = chunks.find((item) => item.id === replacement.id);
  if (!chunk) {
    console.warn(`[skip] ${replacement.id} not found`);
    continue;
  }

  for (const field of ['question', 'answer']) {
    if (typeof chunk[field] !== 'string') continue;
    const next = chunk[field].replace(replacement.from, replacement.to);
    if (next !== chunk[field]) {
      chunk[field] = next;
      changed += 1;
      console.log(`[fix] ${replacement.id}.${field}`);
    }
  }

  if (Array.isArray(chunk.keywords)) {
    chunk.keywords = chunk.keywords.map((keyword) =>
      typeof keyword === 'string' ? keyword.replace(replacement.from, replacement.to) : keyword
    );
  }
}

fs.writeFileSync(CHUNKS_PATH, JSON.stringify(chunks, null, 2));
console.log(`[done] changed=${changed} backup=${CHUNKS_PATH}.textfix.${ts}`);
