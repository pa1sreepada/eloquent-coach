#!/usr/bin/env bash
# GPU contention generator: saturates a local OpenAI-compatible LLM (LM Studio default) with
# 4 parallel long generations for $1 seconds. Run alongside tests/e2e_ws.py to compare ASR configs.
# usage: bash tests/llm_load.sh <seconds> [model] [base_url]
MODEL=${2:-google/gemma-4-e4b}; URL=${3:-http://localhost:1234/v1}
end=$(( $(date +%s) + $1 ))
for w in 1 2 3 4; do (while [ $(date +%s) -lt $end ]; do curl -s -o /dev/null "$URL/chat/completions" -H 'content-type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Write a 400 word essay about meetings.\"}],\"max_tokens\":500}"; done) & done; wait
