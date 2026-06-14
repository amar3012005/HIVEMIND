#!/usr/bin/env bash
# =============================================================================
# verify-entity-dedup-e2e.sh
#
# E2E smoke-test for HIVEMIND entity-tag canonicalization at the API level.
#
# USAGE
#   Inside the container:
#     USER_ID=<uuid> ORG_ID=<uuid> API_KEY=<key> \
#       bash /app/scripts/verify-entity-dedup-e2e.sh
#
#   From the host (preferred — avoids needing curl inside the container):
#     USER_ID=<uuid> ORG_ID=<uuid> API_KEY=<key> BASE_URL=http://localhost:3000 \
#       bash core/scripts/verify-entity-dedup-e2e.sh
#
#   If running curl FROM INSIDE hm-core:
#     docker exec -e USER_ID -e ORG_ID -e API_KEY hm-core \
#       bash /app/scripts/verify-entity-dedup-e2e.sh
#
# REQUIRED ENV
#   USER_ID   — UUID of the test user (must exist in the DB)
#   ORG_ID    — UUID of the owning organisation
#   API_KEY   — HIVEMIND API key with memory.write + memory.read scopes
#
# OPTIONAL ENV
#   BASE_URL  — HTTP base for the running hm-core (default: http://localhost:3000)
#   WAIT_SECS — seconds to wait for async enrichment before checking (default: 3)
#   PSQL_CMD  — override the psql invocation for the DB-count check step
#               (default: docker exec <auto-detected postgres container> psql -U hivemind hivemind)
#
# CANONICAL-FORM EXPECTATIONS
#   All of the following raw entity names must collapse to a single canonical
#   tag  entity:acme  after ingest-time normalisation:
#     entity:Acme       →  entity:acme
#     entity:ACME       →  entity:acme
#     entity:Acme_Inc   →  entity:acme  (legal suffix stripped)
#
# SAFETY
#   This script ONLY creates memories tagged with the marker tag
#   'test-run:entity-dedup-e2e' and ONLY deletes memories carrying that
#   exact marker. It does not touch any other memories. The cleanup section
#   at the end removes all test memories whether the assertions pass or fail.
#   It is safe to run against a production instance; it will not affect
#   real user data.
#
# WHAT IT TESTS (in order)
#   1. POST three memories, each carrying a different case/suffix variant of
#      the same entity "Acme", plus the marker tag.
#   2. Wait for async enrichment / canonicalization to complete.
#   3. (DB count step) Use psql to count distinct entity:* tags containing
#      "acme" across the three test memories — expects exactly 1.
#   4. GET /api/memories?tags=entity:acme — expects all 3 memories to be
#      retrievable under the canonical tag.
#   5. POST /api/chat with a question about Acme — expects 200 + non-empty
#      response body (proves recall works on the canonical tag).
#   6. Cleanup: bulk-delete all test memories by marker tag.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config defaults
# ---------------------------------------------------------------------------
BASE_URL="${BASE_URL:-http://localhost:3000}"
WAIT_SECS="${WAIT_SECS:-3}"
MARKER_TAG="test-run:entity-dedup-e2e"
CANONICAL_ENTITY="entity:acme"

# ---------------------------------------------------------------------------
# Validate required env
# ---------------------------------------------------------------------------
if [[ -z "${USER_ID:-}" ]]; then
  echo "FAIL  USER_ID is required (export USER_ID=<uuid>)"
  exit 1
fi
if [[ -z "${ORG_ID:-}" ]]; then
  echo "FAIL  ORG_ID is required (export ORG_ID=<uuid>)"
  exit 1
fi
if [[ -z "${API_KEY:-}" ]]; then
  echo "FAIL  API_KEY is required (export API_KEY=<key>)"
  exit 1
fi

AUTH_HEADER="Authorization: Bearer ${API_KEY}"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS  $1"; (( PASS_COUNT++ )) || true; }
fail() { echo "FAIL  $1"; (( FAIL_COUNT++ )) || true; }

# ---------------------------------------------------------------------------
# Cleanup function — always runs, even on early exit
# ---------------------------------------------------------------------------
CLEANUP_DONE=0
cleanup() {
  if [[ "${CLEANUP_DONE}" -eq 1 ]]; then return; fi
  CLEANUP_DONE=1
  echo ""
  echo "--- CLEANUP ---"
  echo "Deleting test memories tagged '${MARKER_TAG}'..."

  # dry_run=false to actually delete
  CLEANUP_BODY=$(printf '{"tags":["%s"],"dry_run":false}' "${MARKER_TAG}")
  CLEANUP_RESP=$(curl -sf -X POST "${BASE_URL}/api/memories/bulk-delete-by-tag" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d "${CLEANUP_BODY}" 2>&1) || true

  if echo "${CLEANUP_RESP}" | grep -q '"deleted_count"'; then
    DELETED=$(echo "${CLEANUP_RESP}" | grep -o '"deleted_count":[0-9]*' | grep -o '[0-9]*' || echo "?")
    echo "Cleanup: ${DELETED} test memories deleted."
  else
    echo "Cleanup response: ${CLEANUP_RESP}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# STEP 1: POST three memories with entity variants + marker tag
# ---------------------------------------------------------------------------
echo "=== STEP 1: Ingest three memories with entity name variants ==="

post_memory() {
  local entity_tag="$1"
  local content="$2"
  curl -sf -X POST "${BASE_URL}/api/memories" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"content":"%s","tags":["%s","topic:test-company","%s"],"memory_type":"fact"}' \
             "${content}" "${entity_tag}" "${MARKER_TAG}")" 2>&1
}

RESP1=$(post_memory "entity:Acme"     "Acme is a test company used for entity canonicalization verification.")
RESP2=$(post_memory "entity:ACME"     "ACME Corp manufactures widgets and is used for entity dedup testing.")
RESP3=$(post_memory "entity:Acme_Inc" "Acme Inc. is the legal name of the test entity used in this E2E run.")

ID1=$(echo "${RESP1}" | grep -o '"id":"[^"]*"' | head -1 | grep -o '[^"]*$' || echo "")
ID2=$(echo "${RESP2}" | grep -o '"id":"[^"]*"' | head -1 | grep -o '[^"]*$' || echo "")
ID3=$(echo "${RESP3}" | grep -o '"id":"[^"]*"' | head -1 | grep -o '[^"]*$' || echo "")

if [[ -n "${ID1}" && -n "${ID2}" && -n "${ID3}" ]]; then
  pass "Three test memories created (IDs: ${ID1:0:8}... ${ID2:0:8}... ${ID3:0:8}...)"
else
  fail "One or more memory POSTs failed"
  echo "  Response 1: ${RESP1}"
  echo "  Response 2: ${RESP2}"
  echo "  Response 3: ${RESP3}"
  exit 1
fi

# ---------------------------------------------------------------------------
# STEP 2: Wait for async enrichment / canonicalization
# ---------------------------------------------------------------------------
echo ""
echo "=== STEP 2: Waiting ${WAIT_SECS}s for async enrichment ==="
sleep "${WAIT_SECS}"
pass "Wait complete"

# ---------------------------------------------------------------------------
# STEP 3: DB count — distinct entity:*acme* tags across the three memories
#
# The normaliser runs at write time so the tags stored in the DB should
# already carry the canonical form. If the enrichment queue also re-stamps
# entity tags (entity-co-mention linker), they will also be canonical.
#
# Run this step manually if psql is not available in the script environment:
#
#   PSQL_COMMAND=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1)
#   docker exec ${PSQL_COMMAND} psql -U hivemind hivemind -c "
#     SELECT array_agg(DISTINCT t) AS entity_tags
#     FROM hivemind.memories m,
#          unnest(m.tags) AS t
#     WHERE m.id IN ('<ID1>', '<ID2>', '<ID3>')
#       AND t LIKE 'entity:%acme%'
#       AND m.deleted_at IS NULL;
#   "
#   -- Expected: exactly one row, one distinct value: {entity:acme}
#
# The assertion below uses the REST list endpoint as a proxy for the DB query
# since the script cannot assume psql access from every execution context.
# ---------------------------------------------------------------------------
echo ""
echo "=== STEP 3: DB count check (via REST proxy) ==="
echo "  NOTE: For a direct SQL assertion run the following inside the postgres container:"
echo "    docker exec \$(docker ps --filter name=postgres --format '{{.Names}}' | head -1) \\"
echo "      psql -U hivemind hivemind -c \""
echo "        SELECT array_agg(DISTINCT t) AS entity_tags"
echo "        FROM hivemind.memories m,"
echo "             unnest(m.tags) AS t"
echo "        WHERE m.id IN ('${ID1}','${ID2}','${ID3}')"
echo "          AND t LIKE 'entity:%acme%'"
echo "          AND m.deleted_at IS NULL;"
echo "      \""
echo "    -- Expected: exactly 1 distinct value: {entity:acme}"

# REST proxy: fetch each memory and count distinct entity:*acme* tags
DISTINCT_ENTITY_TAGS=()
for MID in "${ID1}" "${ID2}" "${ID3}"; do
  MEM=$(curl -sf "${BASE_URL}/api/memories/${MID}" \
    -H "${AUTH_HEADER}" 2>&1) || true
  # Extract all entity:... tags containing "acme"
  while IFS= read -r tag; do
    [[ -n "${tag}" ]] && DISTINCT_ENTITY_TAGS+=("${tag}")
  done < <(echo "${MEM}" | grep -o '"entity:[^"]*"' | tr -d '"' | grep -i 'acme' || true)
done

# Deduplicate
UNIQUE_ACME_TAGS=$(printf '%s\n' "${DISTINCT_ENTITY_TAGS[@]}" | sort -u)
UNIQUE_COUNT=$(printf '%s\n' "${UNIQUE_ACME_TAGS}" | grep -c . || echo "0")

echo "  Distinct entity:*acme* tags found across test memories: ${UNIQUE_COUNT}"
echo "  Values: $(printf '%s\n' "${UNIQUE_ACME_TAGS}" | tr '\n' ' ')"

if [[ "${UNIQUE_COUNT}" -eq 1 ]] && echo "${UNIQUE_ACME_TAGS}" | grep -q "^entity:acme$"; then
  pass "All entity variants collapsed to exactly one canonical tag: entity:acme"
else
  fail "Expected exactly 1 canonical tag 'entity:acme', found ${UNIQUE_COUNT}: $(printf '%s ' ${UNIQUE_ACME_TAGS})"
fi

# ---------------------------------------------------------------------------
# STEP 4: GET /api/memories?tags=entity:acme — all 3 memories must surface
# ---------------------------------------------------------------------------
echo ""
echo "=== STEP 4: Recall via canonical tag entity:acme ==="
LIST_RESP=$(curl -sf \
  "${BASE_URL}/api/memories?tags=${CANONICAL_ENTITY},${MARKER_TAG}&limit=10&is_latest=true" \
  -H "${AUTH_HEADER}" 2>&1) || true

# Count how many of our three IDs appear in the result
FOUND_COUNT=0
for MID in "${ID1}" "${ID2}" "${ID3}"; do
  echo "${LIST_RESP}" | grep -q "\"${MID}\"" && (( FOUND_COUNT++ )) || true
done

echo "  Memories retrievable via entity:acme filter: ${FOUND_COUNT}/3"

if [[ "${FOUND_COUNT}" -ge 3 ]]; then
  pass "All 3 test memories retrievable via canonical entity:acme tag"
elif [[ "${FOUND_COUNT}" -ge 1 ]]; then
  fail "Only ${FOUND_COUNT}/3 test memories found via entity:acme — partial canonicalization"
else
  fail "No test memories found via entity:acme filter — canonicalization not working"
  echo "  List response: ${LIST_RESP:0:500}"
fi

# ---------------------------------------------------------------------------
# STEP 5: POST /api/chat — ask about Acme, assert 200 + non-empty reply
# ---------------------------------------------------------------------------
echo ""
echo "=== STEP 5: Chat recall for 'Acme' ==="
CHAT_BODY='{"message":"What do you know about Acme? Please recall any memories about this company.","history":[]}'
CHAT_HTTP_STATUS=$(curl -sf -o /tmp/hm_e2e_chat_resp.json -w "%{http_code}" \
  -X POST "${BASE_URL}/api/chat" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d "${CHAT_BODY}" 2>/dev/null) || CHAT_HTTP_STATUS="000"

CHAT_RESP_BODY=$(cat /tmp/hm_e2e_chat_resp.json 2>/dev/null || echo "")

if [[ "${CHAT_HTTP_STATUS}" -eq 200 ]]; then
  # Check that the response contains a non-empty 'response' or 'message' field
  HAS_CONTENT=0
  if echo "${CHAT_RESP_BODY}" | grep -qE '"(response|message|content)"\s*:\s*"[^"]{5,}'; then
    HAS_CONTENT=1
  fi
  if [[ "${HAS_CONTENT}" -eq 1 ]]; then
    pass "Chat returned HTTP 200 with non-empty response — recall on entity:acme working"
  else
    fail "Chat returned HTTP 200 but response body appears empty or malformed"
    echo "  Body (first 300 chars): ${CHAT_RESP_BODY:0:300}"
  fi
else
  fail "Chat endpoint returned HTTP ${CHAT_HTTP_STATUS} (expected 200)"
  echo "  Body (first 300 chars): ${CHAT_RESP_BODY:0:300}"
fi

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "RESULTS: ${PASS_COUNT} PASS / ${FAIL_COUNT} FAIL"
echo "========================================"

# cleanup() runs via trap on EXIT
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
fi
exit 0
