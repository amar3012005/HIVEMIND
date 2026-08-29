# .claude/memory — new-session context

Read this folder FIRST in any new Claude Code session in this repo. It is the
durable handoff so a fresh session rehydrates instead of restarting. It
complements (does not replace) HIVEMIND recall and the auto-memory index at
`/root/.claude/projects/-root-hivemind/memory/MEMORY.md`.

Every worktree must also query the global MCP server `hivemind-agent-memory`.
Its Cloudflare Agent/SQLite ledger is the cross-worktree durable index for
decisions, architecture gaps, patches, incidents, requirements, and releases.
Git and these reviewed documents remain authoritative; remote memory makes them
discoverable across parallel sessions.

| File | What it holds |
|---|---|
| [session-context.md](session-context.md) | Current state of recall, chat, ingestion, connectors + deploy topology + Solvis test data |
| [recall-pipeline.md](recall-pipeline.md) | How hybrid recall actually works today + the fixes that shipped + what's still open |
| [connectors.md](connectors.md) | Pointer to the full connector decision-doc + one-para state |
| [deploy-topology.md](deploy-topology.md) | Containers, images, git remotes, how to deploy/rollback (incl. the compose `--env-file` gotcha) |
| [llm-provider-config.md](llm-provider-config.md) | THE canonical LLM config — Cerebras→OpenRouter, gpt-oss-120b, no Groq/llama, the chokepoint |
| [../decision-docs/recall_final.md](../decision-docs/recall_final.md) | THE recall record — what was broken (drift/2-stacks/determinism/reranker) + every fix + final architecture |
| [rollback-manifest.md](rollback-manifest.md) | Stable `:stable-20260722` image snapshots for every container + how to roll back |
| [macbook-session-rules.md](macbook-session-rules.md) | Standing rules for laptop sessions: rebase not merge, never deploy from the laptop, verify anything cross-machine against the box's live state |

Standing rules (from the user, do not violate):
- **No patchwork, no rebuild** — production-level upgrades only; reuse over rebuild.
- **Test what actually works first** before building anything.
- **Never spoil** working chat / recall / ingestion. Keep FE-facing API endpoints unchanged.
- **LLM providers: Cerebras or OpenRouter ONLY** (no Groq/llama — those are legacy, being removed).
- Push verified work to `singulance-main` (backend) / `main` (FE). No overwrites, no stale codes.
- Recall is for **millions of docs, enterprise scale** — right context, low latency, high accuracy.
