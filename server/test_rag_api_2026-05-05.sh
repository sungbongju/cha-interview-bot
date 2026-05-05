#!/usr/bin/env bash
set -euo pipefail

cd /home/student04/finbot/server
curl -sS -X POST "http://127.0.0.1:9000/api/interview-chat" \
  -H "Content-Type: application/json" \
  --data-binary @tmp-api-test-sports.json
