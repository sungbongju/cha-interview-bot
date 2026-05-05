// survey-draft-v1 18문항 메타데이터
// 부록 A 매핑 그대로 — Q6~Q23 + Q24

export const MAJORS = [
  '세포유전자재생의학',
  '바이오식의약학',
  '시스템생명과학',
  '스포츠의학',
  '심리학',
  '미술치료',
  '디지털보건의료',
  '경영학',
  '미디어커뮤니케이션학',
  'AI의료데이터학',
  '소프트웨어융합',
]

export const MBTI_LIST = [
  'ISTJ','ISFJ','INFJ','INTJ',
  'ISTP','ISFP','INFP','INTP',
  'ESTP','ESFP','ENFP','ENTP',
  'ESTJ','ESFJ','ENFJ','ENTJ',
]

// condition: 'voice' = 음성/영상 모드 사용자만, 'video' = 영상만, 'revisit' = 재방문자만, 'kakao' = 카카오 진입자만
export const TRUST_QUESTIONS = [
  // Layer 1 봇의 정체성
  { code: 'q06_digital_twin',       layer: 1, num: 6,  text: '이 봇과 대화하면서 박대근 교수님 본인과 대화하는 듯한 느낌을 받았다.' },
  { code: 'q07_institution_id',     layer: 1, num: 7,  text: '이 봇이 차의과학대학교의 공식 도구라고 느껴졌다.' },
  { code: 'q08_ai_disclosure',      layer: 1, num: 8,  text: '이 봇이 사람이 아니라 AI라는 점을 명확히 밝힌다고 느꼈다.' },

  // Layer 2 답변의 품질
  { code: 'q09_rag_grounding',      layer: 2, num: 9,  text: '봇의 답변이 정확하고 사실에 근거한다고 느꼈다.' },
  { code: 'q10_limit_admit',        layer: 2, num: 10, text: '봇이 모르는 내용은 솔직히 "모른다"거나 "교수님께 직접 여쭤보세요"라고 안내했다.' },
  { code: 'q11_warm_tone',          layer: 2, num: 11, text: '봇의 말투가 따뜻하고 친근하게 느껴졌다.' },
  { code: 'q12_format_consistency', layer: 2, num: 12, text: '봇의 답변 스타일이 일관되고 전문적이었다.' },

  // Layer 3 대화의 자연스러움
  { code: 'q13_latency_pacing',     layer: 3, num: 13, text: '봇과의 대화 호흡(질문 후 응답까지의 시간 등)이 자연스러웠다.' },
  { code: 'q14_echo_guard',         layer: 3, num: 14, text: '음성으로 대화할 때 봇 목소리와 내 목소리가 혼동되거나 어색하게 끊기는 일 없이 매끄럽게 진행되었다.', condition: 'voice', conditionLabel: '음성/영상 모드를 사용한 경우에만' },
  { code: 'q15_esc_interrupt',      layer: 3, num: 15, text: '봇이 말하는 도중에 멈추고 싶을 때 멈출 수 있었다 (또는 그런 기능이 있다고 느꼈다).' },
  { code: 'q16_avatar_embodiment',  layer: 3, num: 16, text: '아바타의 입 모양과 표정이 자연스러워 보였다.', condition: 'video', conditionLabel: '영상 모드를 사용한 경우에만' },
  { code: 'q17_mode_switch',        layer: 3, num: 17, text: '영상·음성·텍스트 모드를 자유롭게 전환할 수 있는 점이 좋았다.' },

  // Layer 4 정책과 관계 신호
  { code: 'q18_consent_ui',         layer: 4, num: 18, text: '회원가입 시 개인정보 처리 안내(수집 항목·이용 목적·보유 기간)가 명확하게 제시되었다.' },
  { code: 'q19_guest_browse',       layer: 4, num: 19, text: '로그인하지 않고도 둘러볼 수 있는 옵션이 부담을 덜어주었다.' },
  { code: 'q20_korean_ordinal',     layer: 4, num: 20, text: '봇이 "첫번째 방문을 환영합니다"처럼 자연스러운 한국어 표현으로 인사하는 점이 좋았다.' },
  { code: 'q21_visit_tracking',     layer: 4, num: 21, text: '봇이 내 방문 횟수를 기억하고 인사하는 것이 친근하게 느껴졌다.', condition: 'revisit', conditionLabel: '2회 이상 방문한 경우에만' },
  { code: 'q22_tts_normalize',      layer: 4, num: 22, text: '봇이 영어 약어(AI, GPT 등)를 한국어 발음으로 자연스럽게 읽었다.', condition: 'voice', conditionLabel: '음성/영상 모드를 사용한 경우에만' },
  { code: 'q23_kakao_redirect',     layer: 4, num: 23, text: '카카오톡에서 링크를 눌렀을 때 외부 브라우저로 자동 전환되어 편했다.' },
]

export const OVERALL_QUESTION = {
  code: 'q24_overall_trust', num: 24,
  text: '전반적으로 이 봇을 신뢰할 수 있다고 느꼈다.',
}

export const LAYER_LABELS = {
  1: '봇의 정체성',
  2: '답변의 품질',
  3: '대화의 자연스러움',
  4: '정책과 관계 신호',
}
