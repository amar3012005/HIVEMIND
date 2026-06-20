#!/usr/bin/env bash
# Phase-0 model sweep — runs the room-task battery across N models WITHOUT
# restarting the sidecar (per-turn agentic_model override), and tallies
# tool-call failures from the sidecar log per model. Produces comparison.md.
#
# Run ON THE BOX (host can reach localhost:8060), or inside hm-employees.
# Requires the per-request agentic_model field to be DEPLOYED first.
#
# Required env: ROOM_ID PARTICIPANT_IDS USER_ID ORG_ID  (PROJECT_ID optional)
# Usage:
#   ROOM_ID=... PARTICIPANT_IDS=a,b,c USER_ID=... ORG_ID=... \
#     bash sweep.sh "openai/gpt-oss-120b" "llama-3.3-70b-versatile" "anthropic/claude-haiku-4-5"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/phase0}"; mkdir -p "$OUT_DIR"
MODELS=("$@"); [ ${#MODELS[@]} -eq 0 ] && MODELS=("openai/gpt-oss-120b" "llama-3.3-70b-versatile")
CONTAINER="${EMP_CONTAINER:-hm-employees}"
# tool-call FAILURE markers seen in this codebase's history (400s, harmony leak,
# structured-output miss, fake JSON tool-call) — lower = better tool reliability.
MARKERS='tool_use_failed|did not call a tool|<\|channel\|>|failed_generation|not in request.tools|400 Bad Request|insufficient'

echo "Phase-0 sweep: ${#MODELS[@]} models x battery -> $OUT_DIR"
for M in "${MODELS[@]}"; do
  LABEL="$M"
  echo ""; echo "### model: $LABEL"
  # log offset before the run (count existing marker lines)
  BEFORE=$(docker logs "$CONTAINER" 2>&1 | grep -cE "$MARKERS" || true)
  AGENTIC_MODEL="$M" MODEL_LABEL="$LABEL" OUT_DIR="$OUT_DIR" \
    python3 "$HERE/run_battery.py" || true
  AFTER=$(docker logs "$CONTAINER" 2>&1 | grep -cE "$MARKERS" || true)
  FAILS=$(( AFTER - BEFORE ))
  echo "$FAILS" > "$OUT_DIR/toolfails-${LABEL//\//_}.txt"
  echo "  tool-call-failure log lines this run: $FAILS"
done

# Aggregate -> comparison.md
python3 - "$OUT_DIR" <<'PY'
import json, os, sys, glob
out = sys.argv[1]
rows = []
for f in sorted(glob.glob(os.path.join(out, "battery-*.json"))):
    d = json.load(open(f))
    label = d["model"]
    tf = os.path.join(out, f"toolfails-{label.replace('/','_')}.txt")
    fails = open(tf).read().strip() if os.path.exists(tf) else "?"
    rows.append((label, d["passed"], d["total"], d["avg_ms"], d["total_cost_tokens"], fails))
lines = ["# Phase-0 model comparison", "",
         "| model | battery pass | avg ms/turn | total tok | tool-call fails |",
         "|---|---|---|---|---|"]
for label, p, t, ms, tok, fails in rows:
    lines.append(f"| `{label}` | {p}/{t} | {ms} | {tok} | {fails} |")
lines += ["", "**Decision rule:** the action-path model is the one with the highest battery pass",
          "AND lowest tool-call fails at acceptable ms/tok. If a reliable model clears the",
          "battery with ~0 tool-call fails, Phase 4 (agent-owned actions) is GREEN — and the",
          "JSON-content / tool-less-reactor / placeholder-guard patchwork can be deleted on that",
          "model. If only gpt-oss is affordable and it has nonzero fails, keep the centralized",
          "producer as the action path (no Phase 4 on that model)."]
md = os.path.join(out, "comparison.md")
open(md, "w").write("\n".join(lines) + "\n")
print("\n".join(lines)); print("\n-> wrote", md)
PY
