# Hermes Agent — Sessions, Checkpoints & Rollback (Technical Reference)

Sources: https://hermes-agent.nousresearch.com/docs/user-guide/sessions | https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback

---

## SESSIONS

### Storage
- SQLite DB: `~/.hermes/state.db` — WAL mode (concurrent readers, single writer).
- Tables:
  - `sessions` — metadata: `id, source, user_id, model, title, timestamps, token counts`
  - `messages` — full history: `role, content, tool_calls, tool_name, token_count`
  - `messages_fts` — FTS5 virtual table for full-text search
- Gateway routing index: `~/.hermes/sessions/sessions.json`
- Session ID format: `YYYYMMDD_HHMMSS_<hex>`. CLI/TUI use 6-char hex suffix (`20250305_091523_a1b2c3`); gateway uses 8-char (`20250305_091523_a1b2c3d4`).
- Session `source` tags: `cli, telegram, discord, slack, whatsapp, signal, matrix, mattermost, email, sms, dingtalk, feishu, wecom, weixin, bluebubbles, qqbot, homeassistant, webhook, api-server, acp, cron, batch`.

### Resume CLI commands
```bash
# Continue last CLI session
hermes --continue
hermes -c
hermes chat --continue
hermes chat -c

# Resume named (auto-resumes most recent lineage variant)
hermes -c "my project"

# Resume by ID or by title
hermes --resume 20250305_091523_a1b2c3d4
hermes -r 20250305_091523_a1b2c3d4
hermes --resume "refactoring auth"
hermes chat --resume 20250305_091523_a1b2c3d4
```

### Management CLI commands
```bash
hermes sessions list [--source telegram] [--limit 50]
hermes sessions export backup.jsonl [--source telegram] [--session-id ID]
hermes sessions delete SESSION_ID [--yes]
hermes sessions rename SESSION_ID "new title"
hermes sessions prune [--older-than DAYS] [--source PLATFORM] [--yes]
hermes sessions stats
```

### config.yaml keys (`~/.hermes/config.yaml`)
```yaml
group_sessions_per_user: true   # default true; set false for shared room brain

sessions:
  auto_prune: true              # default: false
  retention_days: 90
  vacuum_after_prune: true
  min_interval_hours: 24

display:
  resume_display: minimal       # default: full
```

### In-chat slash commands
```
/title my research project   # set session title
/title                       # show current title
/compress                    # compress session context
/new [session-name]          # start fresh thread (optional title)
/handoff <platform>          # transfer to messaging platform
/sethome                     # configure platform home channel
/resume <name>               # resume named session
/sessions                    # session picker
```

### Agent-callable session search tool
```python
session_search(query="auth refactor", limit=3)
session_search(session_id="20260510_174648_805cc2", around_message_id=590803, window=10)
session_search()  # browse recent sessions
# Optional: sort="newest"|"oldest"; role_filter="user,assistant,tool" (comma-separated)
```

---

## CHECKPOINTS & ROLLBACK

### Enabling
```bash
hermes chat --checkpoints   # per-session enable
```
Global (`~/.hermes/config.yaml`): `checkpoints.enabled: true`. **Default is `false`** (opt-in as of v2; storage overhead non-trivial over time).

### config.yaml keys (exact)
```yaml
checkpoints:
  enabled: false              # master switch (default: false)
  max_snapshots: 20           # max checkpoints per project
  max_total_size_mb: 500      # hard cap on total store size
  max_file_size_mb: 10        # skip files larger than this
  auto_prune: true            # sweep at startup
  retention_days: 7           # auto-prune retention
  delete_orphans: true        # remove orphaned projects
  min_interval_hours: 24      # prune idempotency interval
```

### When checkpoints are created (automatic)
Before file tools `write_file` and `patch`; before destructive shell commands: `rm, rmdir, cp, install, mv, sed -i, truncate, dd, shred`, output redirects (`>`), and `git reset`/`clean`/`checkout`. Max **one checkpoint per directory per conversation turn**. Skipped if no changes occurred.

### Storage
- Shadow store: `~/.hermes/checkpoints/store/` — single shared **bare git repo** across all projects.
- Per-project refs: `refs/hermes/<project-hash>`
- Per-project indexes: `indexes/<hash>`
- Project metadata: `projects/<hash>.json`
- Legacy v1 archives: `legacy-<timestamp>/`

### In-session rollback slash commands
```
/rollback              # list all checkpoints with change stats
/rollback <N>          # restore to checkpoint N; undoes last chat turn
/rollback diff <N>     # preview diff between checkpoint N and current
/rollback <N> <file>   # restore single file from checkpoint N
```

### CLI checkpoint commands (outside session)
```bash
hermes checkpoints                 # show total size, project count, breakdown
hermes checkpoints status          # same as bare `checkpoints`
hermes checkpoints list            # alias for status
hermes checkpoints prune           # force sweep with garbage collection (git gc --prune=now)
hermes checkpoints clear           # delete entire checkpoint base (prompts first)
hermes checkpoints clear-legacy    # delete only legacy-* archives

hermes checkpoints prune --retention-days 3 --max-size-mb 200
```

### Safety guards
- Disabled if `git` not on `PATH`.
- Skips root `/` and `$HOME` directories.
- Skips directories with >50,000 files.
- Excludes files exceeding `max_file_size_mb`.
- Enforces `max_total_size_mb` by dropping oldest commits; real prune via `git gc --prune=now`.
- Errors logged at debug level; tools continue running.

---

## GOTCHAS
- Checkpoints default OFF — must set `checkpoints.enabled: true` or pass `--checkpoints` for safe-run rollback.
- `/rollback <N>` undoes the last chat turn, not just files — be deliberate.
- Sessions live in SQLite (`~/.hermes/state.db`, WAL); checkpoints live in a separate bare git store (`~/.hermes/checkpoints/store/`) — independent subsystems.
- `group_sessions_per_user: true` (default) isolates per-user; set `false` only for shared-room brain.
- Checkpoint = one snapshot per directory per turn; no-op turns produce no checkpoint.
