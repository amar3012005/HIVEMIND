# HIVEMIND Journal — Master Index

Physical record of every task, decision, incident. Survives Claude Code compaction. Lives in git.

**Read order on new session:**
1. This file (most recent entries top)
2. Latest `daily/<date>/` files
3. Open decisions in `decisions/`
4. Open incidents in `incidents/backlog.md`

---

## Latest entries

_(journal-keeper appends here, newest first)_

- [2026-05-18] Nango Connect UI fix — switched to openConnectUI with self-hosted baseURL (commit `13fffbb`)
- [2026-05-18] Agent army + journal scaffold created (this entry)

---

## By area

### Connectors / MCP
- daily/2026-05-18/nango-self-hosted-bringup.md _(stub)_
- daily/2026-05-18/connect-ui-openconnectui-fix.md _(stub)_

### Memory / Graph
- _(none yet)_

### Frontend
- _(none yet)_

### Infra / Deploy
- _(none yet)_

---

## Decisions

- _(none yet — see decisions/ as they accrue)_

## Open incidents

- See [incidents/backlog.md](incidents/backlog.md)

## Playbooks

- [playbooks/env-matrix.md](playbooks/env-matrix.md) — every env var, where set
- [playbooks/nango-providers.md](playbooks/nango-providers.md) — OAuth provider setup
- [playbooks/deploy.md](playbooks/deploy.md) — production deploy steps

---

## How to add an entry

Use templates from `.claude/agents/journal-keeper.md`. One task = one file in `daily/<date>/`. Always link from this INDEX.
