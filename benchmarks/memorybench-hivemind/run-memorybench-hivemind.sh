#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MB_DIR="$SCRIPT_DIR/memorybench"
ENV_FILE="$MB_DIR/.env.local"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install from https://bun.sh/"
  exit 1
fi

if [ ! -d "$MB_DIR" ]; then
  echo "memorybench repo not found at: $MB_DIR"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Copy and edit: $SCRIPT_DIR/.env.memorybench-hivemind.example -> $ENV_FILE"
  exit 1
fi

RUN_ID="${RUN_ID:-hivemind-$(date +%Y%m%d-%H%M%S)}"
BENCHMARK="${BENCHMARK:-longmemeval}"
JUDGE_MODEL="${JUDGE_MODEL:-gpt-4o}"
ANSWER_MODEL="${ANSWER_MODEL:-gpt-4o-mini}"
LIMIT_ARG=()
SAMPLE_ARG=()

if [ -n "${LIMIT:-}" ]; then
  LIMIT_ARG=(-l "$LIMIT")
fi

if [ -n "${SAMPLE:-}" ]; then
  SAMPLE_ARG=(-s "$SAMPLE")
fi

cd "$MB_DIR"
bun install >/dev/null

echo "Running MemoryBench with HIVEMIND provider"
echo "  Run ID: $RUN_ID"
echo "  Benchmark: $BENCHMARK"
echo "  Judge: $JUDGE_MODEL"
echo "  Answering model: $ANSWER_MODEL"

bun run src/index.ts run \
  -p hivemind \
  -b "$BENCHMARK" \
  -j "$JUDGE_MODEL" \
  -m "$ANSWER_MODEL" \
  -r "$RUN_ID" \
  "${LIMIT_ARG[@]}" \
  "${SAMPLE_ARG[@]}" \
  "$@"

echo
echo "Done. Check outputs:"
echo "  $MB_DIR/data/runs/$RUN_ID/"
echo
echo "To inspect in UI:"
echo "  cd $MB_DIR && bun run src/index.ts serve"

