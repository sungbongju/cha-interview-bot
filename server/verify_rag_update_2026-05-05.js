const fs = require('fs');

const chunks = JSON.parse(fs.readFileSync('/home/student04/finbot/server/data/cha_rag_chunks.json', 'utf8'));
const embeds = JSON.parse(fs.readFileSync('/home/student04/finbot/server/data/cha_rag_embeddings.json', 'utf8'));
const serialized = JSON.stringify(chunks);

console.log(`chunks=${chunks.length}`);
console.log(`embeds=${embeds.length}`);
console.log(`last=${chunks.at(-1)?.id}`);
console.log(`has_space_nerve_treatment=${serialized.includes('신경 치료')}`);
console.log(`has_joined_nerve_treatment=${serialized.includes('신경치료')}`);
console.log(`ch079_has_bad_text=${chunks.find((item) => item.id === 'ch-079')?.answer.includes('활생학')}`);
console.log(`ch082_has_bad_text=${chunks.find((item) => item.id === 'ch-082')?.answer.includes('기업 단방')}`);

const sections = chunks.reduce((acc, chunk) => {
  acc[chunk.section] = (acc[chunk.section] || 0) + 1;
  return acc;
}, {});

for (const section of ['시스템생명과학', '심리학', '미술치료', '스포츠의학', '디지털보건의료', '미디어커뮤니케이션학', '소프트웨어융합', '바이오식의약학', 'AI의료데이터학', '세포유전자재생의학']) {
  console.log(`${section}=${sections[section] || 0}`);
}
