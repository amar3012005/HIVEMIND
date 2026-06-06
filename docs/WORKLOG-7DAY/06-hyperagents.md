# 06 — HyperAgents (multi-agent swarm rooms)

AgentScope ReAct swarm: lead → R1 hypotheses → R2 peer review → R3 refine →
R4 skeptic → R5 vote → synthesis. Landed **May 31 – Jun 6**.

## Commits (backend)

| SHA | Summary |
|-----|---------|
| `873308d` | durable CSI artifact graph for HyperAgents |
| `e15c66d` | recursive CSI convergence loop |
| `853422d` | self-healing sweeper re-kicks dropped sidecar turns |
| `a27c21d` | reasoning_effort=low on groq gpt-oss-20b — cut first-turn latency |
| `8ce99a6` | cut per-round agent stagger 1.5s→0.25s/idx (~15s of dead sleep removed) |

## Commits (frontend / Da-vinci)

| SHA | Summary |
|-----|---------|
| `b2a095f` | render reactor `.line` prose, hide raw `{react:false}`/JSON dumps |
| `564db3f` | polling fallback so rooms render+complete even when EventSource is blocked |
| `93a0038` | MiroFish-style agent qualifications popup + talk-to-expert drawer |
| `f4ed3c4` | recursive CSI convergence trail in room UI |
| `d9b3ee7` / `a7de017` | room UX: direct-open, last-used time, token chip, robust create modal |

## What was built

### Durable CSI artifact graph
- Prisma `HyperClaim` / `HyperTrial` / `HyperRelation` models + migration.
- Control-plane tees turn events (hypothesis/CoT/line/peer_review/react/vote/
  validate/skeptic) into artifact tables — best-effort, never blocks append/seal.
- `GET /v1/hyper-rooms/:id/artifacts` (session + org scoped).

### Recursive convergence loop
- Swarm no longer single-pass R1–R5. R2→R5 wrapped in a convergence cycle:
  cycle 1 reviews R1 hypotheses; cycle 2+ carries refined hypotheses forward +
  injects prior dissent + Skeptic alternatives, re-runs until verdict converges
  (AGREED, or CONDITIONAL ≥ 3.2), cycle cap, or cost/deadline.
- Caps: `MAX_CYCLES=6`, `MAX_TOOL_CALLS=400`, `MAX_WALL_SECONDS=600`.

### Reliability + latency
- **Self-healing sweeper**: `setInterval(15s)` re-kicks turns stuck `live` with
  empty lines (fire-and-forget sidecar kicks drop intermittently).
- **Latency cuts**: `reasoning_effort=low` on gpt-oss-20b (medium default burned
  reasoning tokens × ~15 swarm calls); stagger 1.5s→0.25s/idx removed ~15s of
  dead sleep — rounds now run truly parallel.
- **FE robustness**: polling fallback renders rooms even when browser extensions
  block EventSource; reactor `.line` prose rendered instead of raw JSON.

## Known-open (see STRATEGY.md)
- First-turn latency still ~18s (6–7 sequential phases + upfront company-brief
  recall fan-out + per-agent ReAct round-trips). Proposed fix: MiroFish-style
  shared-blackboard pre-RAG (recall once, inject snapshot → mandatory grounding =
  kills hallucination + single-shot = fast) + lead-first streaming. **Not yet implemented.**
