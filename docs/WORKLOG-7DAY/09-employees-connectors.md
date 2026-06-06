# 09 — Digital Employees & Connectors

Landed **May 31 – Jun 1**.

## Employees

| SHA | Summary |
|-----|---------|
| `d1ffdab` | Phase-1 self-improvement loop + finish metrics |
| `7ae857d` | deploy + metrics endpoints |
| `5490273` | chat with any non-archived employee (incl. draft) |
| `f15382b` | mint scoped api_key on-demand in chat-profile for never-deployed drafts |
| `596ec63` | org-scope chat-profile resolution (slug not globally unique) |

### Self-improvement loop (was inert — archive never written)
- `autonomous-scorer.js`: role-keyed 0–1 scoring
  (consistency/completeness/clarity/depth).
- `POST /v1/employees/:id/eval` (master-key): scores + appends
  `archive/evaluations/<key>_evals.jsonl`.
- Sidecar `report_eval()` fired per turn in 1-1 chat + hyper-rooms (R1–R5) +
  team-tasks → evals accumulate from real usage, no user friction.
- `prompt-tune.mjs`: Groq teacher proposes improved prompt from low-scoring evals;
  A/B on role tasks scored autonomously; promote variant (delta>0.03 & >0.65) to
  `archive/prompt_variants/`. Runtime already consumes `active_prompt_version` →
  tuned prompt takes effect.
- `POST /v1/employees/:id/tune` (org-admin) spawns the tuner; FE "Tune now" button
  + variant review.
- Metrics wired into hyper-rooms (7 sites, real tokens) + team-tasks.

## OAuth / MCP connectors

| SHA | Summary |
|-----|---------|
| `eae76a6` | redesign Connect/consent page — glass card, tier select, scope chip grid |
| `d30edd6` | serve path-suffixed PRM + resource=MCP URL for Claude connectors |
| `0947da5` (FE) | vercel suffixed .well-known oauth rewrites |

## Slack

| SHA | Summary |
|-----|---------|
| `8b16b3b` | own the save flow — summarize last ~10 via LLM, canonical ingest, bypass agent |
| `6cfcb03` | clickable project buttons for save (Block Kit + interactivity endpoint) |
| `54fdcaf` | send Block Kit blocks as JSON string (_call form-encodes) |
| `ef27042` | use valid MemoryType 'conversation' for saved summary |
| `e4f496a` | drop im:write from BOT_SCOPES (install error on new workspaces) |

The Slack save flow was rebuilt to summarize the last ~10 messages via LLM and
route through the **canonical createMemory ingest** (bypassing the agent), with
clickable Block Kit project buttons for save targeting.
