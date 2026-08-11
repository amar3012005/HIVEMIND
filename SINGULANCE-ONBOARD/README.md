# SINGULANCE Onboard

> **SINGULANCE - the AI operating system for companies that remember, reason, and act.**

SINGULANCE is building the practical version of **run your own company with AI**.
It combines organizational memory, an agentic operating system, and a voice
interface in one tenant-safe platform. The target bar is mature-platform
reliability, security, observability, and product coherence - not disconnected demos.

This folder is the entry point for any new agent or human session — **Codex on a
developer's localhost, Claude on the production box, and people** alike. Anyone
can `git pull` it and read it before touching production. It links canonical
source/runbook files instead of copying historical design documents. Treat live
service state as something to verify, not as a claim in documentation.

## Product Map

| Product | Product role | What it owns |
| --- | --- | --- |
| **HIVEMIND** | Brain / organizational memory | Memories, recall, graph, document and connector ingestion, workspaces, projects, members, API keys, MCP, meeting intelligence. |
| **HyperAgents** | Operating System / agentic workforce | Company onboarding, company context, persistent rooms, digital employees, simulations, debate, synthesis, and memory-grounded work. |
| **TARA** | Voice | Voice-agent configuration and real-time customer/team interactions, with Deepgram as part of the voice runtime. |

The global navigation uses **BRAIN | Operating System | VOICE**. The product
identity at the top left changes with the active area: HIVEMIND, HyperAgents, or TARA.

## Read In This Order

1. [SESSION-START.md](SESSION-START.md) - mandatory orientation and safety checks.
2. [PRODUCTS.md](PRODUCTS.md) - user-facing scope and ownership boundaries.
3. [ARCHITECTURE.md](ARCHITECTURE.md) - services, data planes, and request flow.
4. [MEMORY-LAYER.md](MEMORY-LAYER.md) - the critical ingestion/recall substrate.
5. [OPERATIONS.md](OPERATIONS.md) - the current quick-deploy model, the two
   checkouts, and image hygiene.
6. [SHIPPING.md](SHIPPING.md) - ship a feature in one command; roll back in one
   command; the verify checklist.
7. [COLLABORATION.md](COLLABORATION.md) - **read before you push.** Parallel-agent
   rules (Claude on the box, Codex on localhost) so no one overwrites anyone.
8. [SECURITY.md](SECURITY.md) - hardened controls, open risks, and next security work.

## Ship / Roll Back In One Line

```bash
git push origin singulance-main                    # from localhost (Codex/dev)
bash /root/quick-deploy.sh singulance-main         # on the box (build changed → run :latest)
bash /root/quick-deploy.sh --rollback <service>    # one-command revert to :stable
```

`singulance-main` is the ONE deploy branch. The box builds from
`/root/hivemind-next` (clean, on `singulance-main`) — **not** from `/root/hivemind`
(the intentionally-dirty scratch checkout). See [OPERATIONS.md](OPERATIONS.md).

## Non-Negotiable Principles

- One product frontend serves the platform. Do not fork B2B and B2C frontends.
- The central engine API remains stable across managed and self-hosted tenants;
  only storage resolution changes per organization.
- Personal users default to `.amr`. Managed enterprise uses PostgreSQL plus
  Qdrant. Self-hosted enterprise keeps memory data on the customer Box while
  identity, billing, and control remain central.
- Backend enforcement is authoritative for identity, tenancy, entitlements, and
  usage. Frontend counters are informational only.
- Production ships via `quick-deploy.sh`: only changed services rebuild, each
  keeps exactly `:latest` (live) + `:stable` (one-command rollback), and every
  deploy is health-gated. Never build from or reset the dirty scratch checkout
  (`/root/hivemind`); the build source is `/root/hivemind-next` on `singulance-main`.
- `singulance-main` is the single deploy branch. Never force-push it; stage only
  your own files; one deployer at a time. See [COLLABORATION.md](COLLABORATION.md).
- Security and data integrity outrank feature speed.

## Canonical Sources

- [`.claude/INSTRUCTIONS.md`](../.claude/INSTRUCTIONS.md) - durable working and production rules.
- [`.claude/MEMORY.md`](../.claude/MEMORY.md) - verified production history and decisions.
- [`Security-hardening-journal.md`](../Security-hardening-journal.md) - phase-by-phase security record.
- [`docs/architecture/README.md`](../docs/architecture/README.md) - storage/deployment architecture.
- [`docs/HYPERAGENTS_README.md`](../docs/HYPERAGENTS_README.md) - rooms and digital employee runtime.
- [`byod/README.md`](../byod/README.md) and [`byod/TRANSPORT.md`](../byod/TRANSPORT.md) - customer Box bundle and transport.

## Scope Discipline

Do not turn this folder into a second implementation specification. Update it
when a durable product boundary, operational rule, or verified production fact
changes. Put detailed implementation decisions next to the code or in existing
canonical docs.
