#!/usr/bin/env bash
# 설문 저장 종단(end-to-end) 검증 스크립트
# 사용처: 운영 학교 서버에서 마이그레이션 후 실행
#
# 절차:
#   1) DB 마이그레이션 (schema.sql의 survey_responses 블록)
#   2) api.php 배포 (handleSaveSurvey + case 'save_survey')
#   3) Vercel 배포 (api/school-api.js)
#   4) 본 스크립트로 종단 테스트

set -euo pipefail

API="${API_BASE:-https://cha-interview-bot.vercel.app/api/school-api}"
SESSION_ID="verify_$(date +%s)"

echo "==> [1/3] save_survey POST"
RESP=$(curl -sS -X POST "${API}?action=save_survey" \
  -H 'Content-Type: application/json' \
  -d "{
    \"session_id\": \"${SESSION_ID}\",
    \"survey_version\": \"v1\",
    \"grade\": \"1\",
    \"gender\": \"female\",
    \"mbti\": \"INFJ\",
    \"major1\": \"경영학\",
    \"major2\": \"none\",
    \"q06_digital_twin\": 1,
    \"q07_institution_id\": 1,
    \"q08_ai_disclosure\": 1,
    \"q09_rag_grounding\": 1,
    \"q10_limit_admit\": 1,
    \"q11_warm_tone\": 1,
    \"q12_format_consistency\": 0,
    \"q13_latency_pacing\": 1,
    \"q14_echo_guard\": null,
    \"q15_esc_interrupt\": 1,
    \"q16_avatar_embodiment\": null,
    \"q17_mode_switch\": 1,
    \"q18_consent_ui\": 1,
    \"q19_guest_browse\": 1,
    \"q20_korean_ordinal\": 1,
    \"q21_visit_tracking\": null,
    \"q22_tts_normalize\": null,
    \"q23_kakao_redirect\": null,
    \"q24_overall_trust\": 1,
    \"free_positive\": \"검증 케이스: 자동 테스트입니다.\",
    \"free_negative\": \"\",
    \"duration_seconds\": 215
  }")

echo "응답: ${RESP}"

echo ""
echo "==> [2/3] 응답 파싱 검증"
SUCCESS=$(echo "$RESP" | grep -o '"success":[a-z]*' | head -1 | cut -d: -f2)
ID=$(echo "$RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
TOTAL=$(echo "$RESP" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)

if [ "$SUCCESS" = "true" ] && [ -n "$ID" ]; then
  echo "  ✓ success=true, id=${ID}, total_yes=${TOTAL}"
  echo "  예상 layer_scores — L1=3 L2=3 L3=3 L4=3 total=12"
else
  echo "  ✗ FAIL — 응답: ${RESP}"
  exit 1
fi

echo ""
echo "==> [3/3] DB에서 직접 SELECT (학교 서버에서 mysql 사용)"
echo "  다음 명령을 학교 서버에서 실행:"
echo ""
echo "  mysql -u \$CHA_DB_USER -p cha_interview_db -e \\"
echo "    \"SELECT id, session_id, grade, gender, mbti, major1, total_yes_count, layer1_score, layer2_score, layer3_score, layer4_score, submitted_at FROM survey_responses WHERE session_id='${SESSION_ID}'\""
echo ""
echo "  기대 결과 1행: total_yes_count=12, L1=3, L2=3, L3=3, L4=3"
