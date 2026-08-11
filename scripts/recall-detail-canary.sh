#!/usr/bin/env bash
# recall-detail-canary — does /api/chat still answer SMALL DETAILS from source text?
#
# WHY THIS EXISTS
# On 2026-08-03 five small-detail questions (a price, a part number, a kW rating, a
# surname, a meter model) all returned "nothing directly answers your question" while
# every answer sat verbatim in knowledge_segments. Direct SQL: 0 of 485 memories held
# any of them. It took FOUR production deploys to find the cause, because THREE gates
# in series each returned an empty result indistinguishable from "nothing to find":
#
#   1. evidence-retrieval.js  `limit` sized both the fetch AND the returned slice, so
#      the cross-encoder saw 12 candidates while RERANK_POOL=150 sat unused.
#   2. recall-router hop2Evidence  a three-way gate that ran evidence only on document
#      anchors, else only when hop-1 was "sparse", else returned {items: []}.
#   3. recallPlan.expand_evidence  false for mode 'fact', short-circuiting the lane to
#      {items: [], reason: 'disabled'} BEFORE hop2Evidence was even entered.
#
# Each fix looked correct and changed nothing, because the next gate downstream was
# still shut. What ended it was one unconditional counter: [recall-hybrid] ev_in=0.
#
# So this canary asserts BOTH the outcome and the mechanism. Outcome alone would go
# green the moment memories happen to contain a fact; mechanism alone would go green on
# a lane that retrieves and then gets ignored. A gate closing again fails this, loudly,
# before a user ever asks.
#
# Usage:  CORE_URL=http://localhost:2026 API_KEY=hmk_live_... ./recall-detail-canary.sh
# Exit:   0 all pass · 1 an answer regressed · 2 the evidence lane went dark
set -uo pipefail

CORE="${CORE_URL:-http://localhost:2026}"
KEY="${API_KEY:?API_KEY (a scoped core key) is required}"
SINCE="${LOG_SINCE:-3m}"
CONTAINER="${CORE_CONTAINER:-hm-core}"

# question|regex that MUST appear in the answer. Each fact is verbatim in a segment and
# in NO memory — so a pass proves the evidence lane reached the answer.
CASES=(
  "Was kostet der Umbausatz Hydraulik WP für SolvisMia 8 monovalent?|13[.,]050"
  "Welche Artikelnummer hat das Anschlussset oberirdisch Pia?|35113"
  "Was ist die Teillast des SolvisBruno 7kW?|3[.,]7"
  "Wer ist der Vorstadtmann?|Jablonski"
  "Which additional meter is required for the dashboard?|E3DC"
)

pass=0; fail=0
for c in "${CASES[@]}"; do
  q="${c%%|*}"; re="${c##*|}"
  body=$(printf '%s' "$q" | python3 -c 'import json,sys; print(json.dumps({"message":sys.stdin.read(),"stream":False}))')
  ans=$(curl -sS -m 150 -X POST "$CORE/api/chat" -H "x-api-key: $KEY" \
        -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
  if printf '%s' "$ans" | grep -qE "$re"; then
    printf 'PASS  %-46.46s %s\n' "$q" "$re"; pass=$((pass+1))
  else
    printf 'FAIL  %-46.46s expected /%s/\n' "$q" "$re"; fail=$((fail+1))
  fi
done

echo
echo "answers: $pass pass / $fail fail"

# ── MECHANISM GATE ──────────────────────────────────────────────────────────────
# ev_in is how many evidence rows reached deliverHybrid. ev_in=0 means a gate upstream
# closed — the exact signature of all three regressions above. This must fail even if
# every answer happened to pass, because a passing answer sourced only from memories is
# one ingestion change away from silently breaking.
lanes=$(docker logs "$CONTAINER" --since "$SINCE" 2>&1 | grep '\[recall-hybrid\]' | tail -5)
echo "--- lane counters ---"; printf '%s\n' "${lanes:-<none>}"

if [ -z "$lanes" ]; then
  echo "CANARY FAIL: no [recall-hybrid] counter at all — the delivery pipeline did not run." >&2
  exit 2
fi
if ! printf '%s' "$lanes" | grep -qE 'ev_in=[1-9]'; then
  echo "CANARY FAIL: ev_in=0 — THE EVIDENCE LANE IS DARK. Check, in order:" >&2
  echo "  1. recallPlan.expand_evidence (recall-router.js ~:241) — is it false for this mode?" >&2
  echo "  2. the hop2Evidence call guard (~:1481) — short-circuited to reason:'disabled'?" >&2
  echo "  3. retrieveEvidence depth/deliver + the document scope filter — returning []?" >&2
  exit 2
fi
if printf '%s' "$lanes" | grep -q 'DEGRADED: no cross-encoder'; then
  echo "WARN: cross-encoder degraded on at least one query — lanes were interleaved," >&2
  echo "      not ranked. Cross-lingual lookups are the first thing to suffer." >&2
fi

[ "$fail" -eq 0 ] || exit 1
echo "CANARY PASS: small details answerable from source text, evidence lane live."
