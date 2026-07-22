# Session context — as of 2026-07-22

## What is live right now
- **core-api image:** `prod-20260722-rmye01367541` (healthy). Backend HEAD on `singulance-main` @ `e01367541`.
- **FE:** `main` @ `1ab5f62`; both `singulancelabs.com` and `next.singulancelabs.com` serve it (recreated).
- Containers healthy: `hm-core`, `hm-fe`, `hivemind-next-frontend-1`, `tara-deepgram`, `hm-employees`, `hm-caddy`, `hm-control`.

## Recall / chat / ingestion — state
Working. Chat answers correctly across fact/source/full/compare/relation/temporal/profile/save/update
(EN+DE). Stage A (always-on compact profile preload), Stage B (`update_user_profile` +
terminal writes), Stage C (gatherEvidence → EvidenceBus capability-dispatch) are all
SHIPPED — see the auto-memory index for the per-stage prod tags. The chat
orchestration re-architecture plan (`synchronous-popping-journal.md`) is COMPLETE.

**Recall production upgrade (this session) — live:** index-accelerated Postgres FTS +
trigram for scale (millions of docs), pg_trgm schema-qualify fix, rerank-nullification
guard, evidence-citability fix, 'simple' multilingual FTS config. Details in
[recall-pipeline.md](recall-pipeline.md).

**Gotcha — test regex false-negatives:** live chat verification of "when is solvis pia
launching" returned all 6/6 correct ("Solvis PIA is scheduled to launch on 18 August
2026") but a brittle regex `/18 august|august 18/i` scored 1/6 — the LLM emits a unicode
space between "18" and "August" on some runs. When verifying chat, match on normalized
text (strip/normalize whitespace, `\s+`), never a literal-space regex.

## Solvis test data (the running example the user tests with)
- Org has SOLVIS project with sub-brands. "Solvis PIA" launch date = **18 August 2026**
  (was Aug-18; a temporal/history test expects "changed from Aug-18 to Aug-19" — that is
  fix#2, the timeline predecessor-walk, now surfacing live).
- "Solvis TIM" is a distinct entity — entity-slug normalization matters
  (SolvisTim→solvistim vs "solvis tim"→solvis-tim was an inconsistency worth watching).
- Ingestion example the user runs: "lets launch solvis pia ... save this in SOLVIS".

## Connectors — state
Connector Runtime V1 is LIVE (7 connectors / 35 tools). Master + MCP + Chat + Hyper flags
on; TARA baked (env-gated); SYNC mounted but off. Full detail:
[connectors.md](connectors.md) → `/root/hivemind/.claude/decision-docs/connector_tools.md`.

## Immediate open items (non-blocking)
1. Refine notion/github/linear provider tool-names at first live MCP `tools/list` inspect.
2. Residual synthesis non-determinism (~occasional generic answer) is LLM-level, structural
   causes addressed; do NOT patchwork the prompt (that regressed chat 6/6→0/5 once — rolled back).
3. Approval convergence (Hyper `_PENDING_WRITES` ContextVar → shared `PendingWrite`).

## How to bootstrap a new session
Run the HIVEMIND recall bootstrap (see repo CLAUDE.md), read this folder, then check
`git log --oneline -5` on `singulance-main` and `docker ps` for the live image tag.
