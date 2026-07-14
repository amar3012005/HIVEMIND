# Next Session Prompt

```text
Continue production work on SINGULANCE in /Users/amar/HIVE-MIND.

Product goal: SINGULANCE is an AI operating system for companies that remember, reason, and act. HIVEMIND is the memory brain, HyperAgents is the operating system/workforce, and TARA is the voice layer. The quality bar is a reliable, tenant-safe enterprise SaaS, not a demo.

Read first:
1. SINGULANCE-ONBOARD/README.md
2. SINGULANCE-ONBOARD/SESSION-START.md
3. SINGULANCE-ONBOARD/CURRENT-PRODUCTION-STATUS.md
4. SINGULANCE-ONBOARD/MEMORY-LAYER.md
5. docs/PRODUCTION_REAL_USER_TEST_CHECKLIST.md
6. docs/PRODUCTION_RELEASE_PROTOCOL.md
7. .claude/INSTRUCTIONS.md and .claude/MEMORY.md

Hard rules:
- Production is ONLY the SINGULANCE engine reached with `ssh singulance`. Never use `myserver`.
- Inspect git status, active containers/images, routes, environment pins, health, and logs before production work. The live checkout is dirty: never pull, reset, or build from it.
- Use the code-review graph before filesystem exploration. Preserve unrelated parallel edits and use apply_patch for manual edits.
- Build from one pushed parent commit in a clean checkout. Release tags are immutable `prod-YYYYMMDD-<parent-sha>`; pin Compose `VERSION` and `NEXT_VERSION` to that tag. `stable` and `latest` are aliases only.
- Before deployment: show diff, verify frontend gitlink, run focused tests and image smoke checks. Preserve rollback tags before recreation. After deployment: verify active image IDs, served frontend marker, public health, and logs.
- Do not deploy documentation-only changes. Never print, commit, or store production secrets. Do not send email, make a real call, or charge Stripe without explicit approval and a safe test target.
- Tenant isolation is mandatory. Keep `/api/knowledge/upload`, `/api/recall`, and `/api/chat` backward-compatible unless a staged migration proves parity.

Verified production truth on 2026-07-14:
- Dashboard, core, control, HyperAgents, and TARA run `prod-20260714-8f049395`; dashboard/API/core health are 200 and logs have no fresh fatal/unhandled errors.
- `next.singulancelabs.com/hivemind` is the customer dashboard. `hm-fe` serves the public homepage and currently uses mutable `home-latest`; do not confuse it with a stale dashboard, but plan to make it immutable.
- A real managed-enterprise tenant has 37 parsed documents, 937 segments, and 199 evidence links. Authenticated document browsing works. Scoped source recall passed: fact 1.131s, explain 1.027s, full 644ms with evidence.
- Explicit recall modes are source-aware and bounded. Chat still uses the plan-then-act React agent; RecallPacket is additive/shadow, not yet a full user-visible cutover.

Continue the production checklist one item at a time. Capture evidence for the actual tenant and distinguish production-proven behavior from deployed code awaiting acceptance.

Next tests in order:
1. Authenticated browser login/refresh and selected-org persistence.
2. Save memory -> Memories -> Graph -> scoped recall.
3. Upload a small document -> pages -> segments -> filename/source chat answer with citations.
4. Compare fact/explain/full in the UI, including latency/cutoff.
5. HyperAgents room create -> automatic first run -> stream -> synthesis -> plan-limit gate.
6. Second authorized member document-visibility test. Do not widen document scope until policy is chosen.
7. Dedicated Gmail grant/reply loop, then deliberate TARA allowlist test, then optional Stripe test only with approval.

Do not claim feature completeness from source code alone. Update the status document and checklist only after live evidence exists. Commit each isolated change independently.
```
