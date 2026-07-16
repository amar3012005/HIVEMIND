# SINGULANCE Onboard

> **SINGULANCE - the AI operating system for companies that remember, reason, and act.**

SINGULANCE is building the practical version of **run your own company with AI**.
It combines organizational memory, an agentic operating system, and a voice
interface in one tenant-safe platform. The target bar is mature-platform
reliability, security, observability, and product coherence - not disconnected demos.

This folder is the entry point for a new Codex session. It links canonical
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

1. [SKILL.md](SKILL.md) - mandatory production release, rollback, and image-retention rules.
2. [SESSION-START.md](SESSION-START.md) - mandatory orientation and safety checks.
3. [CURRENT-PRODUCTION-STATUS.md](CURRENT-PRODUCTION-STATUS.md) - verified runtime state and acceptance gaps.
4. [PRODUCTS.md](PRODUCTS.md) - user-facing scope and ownership boundaries.
5. [ARCHITECTURE.md](ARCHITECTURE.md) - services, data planes, and request flow.
6. [MEMORY-LAYER.md](MEMORY-LAYER.md) - the critical ingestion/recall substrate.
7. [OPERATIONS.md](OPERATIONS.md) - deployment rules and safe container retirement.
7b. [DEPLOYMENT.md](DEPLOYMENT.md) - **strict fast-deploy procedure for Codex/AI agents** (single-branch quick-deploy, one `:stable` rollback, hard rules that have broken prod before). Read before shipping anything.
8. [SECURITY.md](SECURITY.md) - hardened controls, open risks, and next security work.
9. [RELEASE-POLICY.md](RELEASE-POLICY.md) - stable/latest service map and retention policy.
10. [NEXT-SESSION-PROMPT.md](NEXT-SESSION-PROMPT.md) - handoff prompt for a new implementation session.

## Non-Negotiable Principles

- One product frontend serves the platform. Do not fork B2B and B2C frontends.
- The central engine API remains stable across managed and self-hosted tenants;
  only storage resolution changes per organization.
- Personal users default to `.amr`. Managed enterprise uses PostgreSQL plus
  Qdrant. Self-hosted enterprise keeps memory data on the customer Box while
  identity, billing, and control remain central.
- Backend enforcement is authoritative for identity, tenancy, entitlements, and
  usage. Frontend counters are informational only.
- Production changes are immutable-image, health-gated, and rollbackable. Never
  build from or reset the dirty live checkout.
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
