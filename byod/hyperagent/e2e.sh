#!/usr/bin/env bash
# Prove native HyperAgent Harness UI locally. No production calls except optional CP health.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${HARNESS_PORT:-13080}"
BASE="http://127.0.0.1:${PORT}"
fail=0
say(){ printf '%-6s %s\n' "$1" "$2"; }

code="$(curl -sS -o /tmp/ha-health.json -w '%{http_code}' --max-time 5 "$BASE/health" || echo 000)"
if [[ "$code" == 200 ]] && grep -q '"ok":true' /tmp/ha-health.json; then
  say OK "GET /health $code $(cat /tmp/ha-health.json)"
else
  say RED "GET /health $code"; fail=1
fi

code="$(curl -sS -o /tmp/ha-root.html -w '%{http_code}' --max-time 5 "$BASE/" || echo 000)"
if [[ "$code" == 401 ]] && grep -qi 'dsh web authentication required' /tmp/ha-root.html; then
  say OK "GET / $code native web gate (Connect to HIVEMIND / dsh web)"
elif [[ "$code" == 200 ]] && grep -Eiq '__ModuleLoader__|harness-shell|html' /tmp/ha-root.html; then
  say OK "GET / $code native web"
else
  say RED "GET / $code"; fail=1
  head -c 200 /tmp/ha-root.html; echo
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/assets/harness-shell.js" || echo 000)"
if [[ "$code" == 200 || "$code" == 404 ]]; then
  say OK "GET /assets/harness-shell.js $code (200=hashed shell, 404=boot injections still native)"
else
  say RED "GET /assets/harness-shell.js $code"; fail=1
fi

preset="$(docker exec hm-byod-harness node -e "const fs=require('fs'); const t=fs.readFileSync('/opt/deepseek-harness/packages/bundle/hivemind-web-app/cordis.patch.yml','utf8'); const m=t.match(/allowed: \\[([^\\]]+)\\]/); process.stdout.write(m?m[1]:'missing')" 2>/dev/null || true)"
if [[ "$preset" == "hyperagents" ]]; then
  say OK "image agent-presets allowed=hyperagents"
else
  say RED "image allowed presets=$preset (want hyperagents)"; fail=1
fi

name="$(docker inspect -f '{{.Config.Image}}' hm-byod-harness 2>/dev/null || true)"
say OK "container image $name"
[[ "$fail" -eq 0 ]] || exit 1
say OK "open $BASE then Connect to HIVEMIND (https://preview-api.singulancelabs.com)"
