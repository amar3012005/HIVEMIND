#!/usr/bin/env bash
set -euo pipefail

# Generate the exact native Harness SPA once, then publish it as Worker Static
# Assets. API/SSE/WebSocket traffic remains dynamic; this script never touches
# the runner image or the central HIVE data stores.
source_dir="${HIVEMIND_HARNESS_SOURCE:-/Users/amar/deepseek-harness-profile-persistence}"
target_dir="$(cd "$(dirname "$0")/../workers/harness-chat" && pwd)/public"

test -f "$source_dir/apps/web/package.json"
test -d "$target_dir"

pnpm --dir "$source_dir" --filter @deepseek-ai/dsh-web-frontend build
rsync -a --delete --exclude='.gitkeep' --exclude='*.map' "$source_dir/apps/web/dist/" "$target_dir/"
printf 'Prepared native Harness static assets in %s\n' "$target_dir"
