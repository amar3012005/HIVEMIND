# Hermes Agent — Features, Cron & Skills Technical Reference

**Sources (crawled 2026-06-07):** https://hermes-agent.nousresearch.com/docs/user-guide/features/overview · /docs/user-guide/features/cron · /docs/user-guide/features/skills · /docs/user-guide/configuration

> Permanent build reference for constructing Hermes agents programmatically. All config keys/CLI/flags below are verbatim from the official docs. No 404s encountered.

---

## 1. Feature Catalog (overview page)

Config-bearing features are detailed in §2–§4; the rest are listed with their primary config surface.

| # | Feature | Primary surface |
|---|---------|-----------------|
| 1 | Tools & Toolsets | `hermes tools`; per-platform toolset config; `enabled_toolsets` |
| 2 | **Skills System** | `~/.hermes/skills/`, `skills:` in config.yaml, `hermes skills` — see §3 |
| 3 | Persistent Memory | `MEMORY.md`, `USER.md` (bounded, cross-session) |
| 4 | Context Files | auto-loads `.hermes.md`, `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursorrules` |
| 5 | Context References | `@file/folder/url/gitdiff` injection |
| 6 | Checkpoints | auto-snapshot before changes; `/rollback` |
| 7 | **Scheduled Tasks (Cron)** | `cron:` in config.yaml, `hermes cron`, `/cron` — see §2 |
| 8 | Subagent Delegation | `delegate_task` tool; 3 concurrent default (configurable) |
| 9 | Code Execution | `execute_code` tool (sandboxed Python RPC) |
| 10 | Event Hooks | gateway + plugin hook types |
| 11 | Batch Processing | parallel prompts → ShareGPT trajectories |
| 12 | Voice Mode | CLI + messaging platforms |
| 13 | Browser Automation | Browserbase, Browser Use, local Chrome/Brave/Chromium/Edge via CDP |
| 14 | Vision & Image Paste | multimodal; clipboard paste |
| 15 | Image Generation | FAL.ai, 9 models (FLUX, GPT-Image, Ideogram, Recraft); `hermes tools` |
| 16 | Voice & TTS | 10 providers: Edge TTS (free), ElevenLabs, OpenAI, MiniMax, Voxtral, Gemini, xAI, NeuTTS, KittenTTS, Piper |
| 17 | MCP Integration | stdio/HTTP servers; per-server tool filtering |
| 18 | Provider Routing | sorting, whitelists, blacklists |
| 19 | Fallback Providers | auto-failover on error |
| 20 | Credential Pools | multi-key auto-rotation |
| 21 | Prompt Caching | built-in 1h prefix cache (Claude); no config |
| 22 | Memory Providers | Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory |
| 23 | API Server | OpenAI-compatible HTTP (Open WebUI/LobeChat/LibreChat) |
| 24 | IDE Integration (ACP) | VS Code, Zed, JetBrains |
| 25 | Personality & SOUL.md | `/personality` presets per session |
| 26 | Skins & Themes | CLI colors/spinners/labels/branding |
| 27 | Plugins | 3 types; `hermes plugins` |

Setup helpers: `hermes setup --portal` (Nous Portal OAuth, recommended for unattended/cron), `hermes tools`, `hermes plugins`.

---

## 2. Scheduled Tasks (Cron)

### 2.1 config.yaml keys (verbatim)

```yaml
cron:
  wrap_response: false        # default: true. false = no header/footer wrapper
  script_timeout_seconds: 300 # default: 120. pre-run script timeout
```

Cron **jobs** themselves are NOT in config.yaml — they live in `~/.hermes/cron/jobs.json` (atomic writes). config.yaml only holds the two `cron:` knobs above.

**Env vars:**
- `HERMES_CRON_SCRIPT_TIMEOUT` — overrides `cron.script_timeout_seconds` (precedence: env → config.yaml → 120s default).
- `TELEGRAM_CRON_THREAD_ID` — (in `.env`) Telegram topic delivery thread id.
- `TELEGRAM_HOME_CHANNEL` — Telegram home channel target.

### 2.2 `hermes cron` CLI (verbatim)

```bash
# CREATE
hermes cron create "<schedule>" "<prompt>" [OPTIONS]
  --skill <name>            # attach skill (repeatable)
  --name <string>
  --workdir <path>          # absolute, must exist; clear with --workdir ""
  --profile <name>          # must exist; clear with --profile ""
  --deliver <target>
  --no-agent                # script-only mode
  --script <filename>       # pre-run script in ~/.hermes/scripts/
  --repeat <n>              # override repeat count
  --enabled-toolsets <list> # cost control

# MANAGE
hermes cron list
hermes cron pause <id_or_name>
hermes cron resume <id_or_name>
hermes cron run <id_or_name>
hermes cron remove <id_or_name>
hermes cron status        # scheduler status
hermes cron tick          # manual scheduler tick

# EDIT
hermes cron edit <id_or_name> [OPTIONS]
  --schedule <expr>
  --prompt <string>
  --skill <name>          # REPLACE skill list
  --add-skill <name>      # append
  --remove-skill <name>
  --clear-skills
  --workdir <path>        # clear with --workdir ""
  --profile <name>        # clear with --profile ""
```

In-chat equivalents: `/cron add <schedule> "<prompt>" [--skill <name>]`, `/cron list|pause|resume|run|remove|edit ...`.

Job lookup accepts hex **ID** or case-insensitive **name**; exact ID wins; ambiguous names refused with candidate IDs.

### 2.3 Schedule formats (verbatim)

| Format | Example | Behavior |
|--------|---------|----------|
| Relative delay | `30m`, `2h`, `1d` | one-shot (repeat=1) |
| Interval | `every 30m`, `every 6h`, `every sunday 9am` | recurring forever (default) |
| Cron expr (5-field) | `0 9 * * *` (daily 9am), `0 */6 * * *` (every 6h) | standard cron |
| ISO timestamp | `2026-03-15T09:00:00` | one-time (repeat=1) |

Default repeat: relative/timestamp = 1; interval/cron = forever. Override via `--repeat <n>` or `repeat=<n>`.

### 2.4 `cronjob` tool params (programmatic / agent-side)

```python
cronjob(
    action="create"|"list"|"update"|"pause"|"resume"|"run"|"remove",
    schedule="0 9 * * *",            # required for create
    prompt="Task description",       # required for create
    skill="name" | skills=["a","b"], # optional; skills loaded in listed order
    name="job-name",                 # optional, auto-generated if omitted
    workdir="/absolute/path",        # optional, must exist
    profile="profile-name",          # optional, must exist
    deliver="telegram,discord",      # optional, default = origin/local
    no_agent=True,                   # optional, script-only
    script="script-name.sh",         # optional, in ~/.hermes/scripts/
    repeat=5,                        # optional
    enabled_toolsets=["web","file"], # optional, cost control
    context_from="job_id" | ["a","b"], # optional, chain prior-job output into prompt
    job_id="<hex-id>",               # required for update/pause/resume/run/remove
)
```

### 2.5 Delivery targets

`origin` (default on messaging), `local` (default on CLI → `~/.hermes/cron/output/`), `telegram`, `telegram:123456`, `telegram:-100123:17585` (`chat_id:thread_id`), `discord`, `discord:#channel`, `slack`, `whatsapp`, `signal`, `matrix`, `mattermost`, `email`, `sms`, `homeassistant`, `dingtalk`, `feishu`, `wecom`, `weixin`, `bluebubbles`, `qqbot`, `all`, comma fan-out (`telegram,discord`), `origin,all` (dedup). Final agent response auto-delivers — no `send_message` needed.

### 2.6 No-agent / pre-run scripts & wakeAgent gate

```bash
hermes cron create "every 5m" --no-agent --script memory-watchdog.sh \
  --deliver telegram --name "memory-watchdog"
```
- Scripts MUST live in `~/.hermes/scripts/` (enforced). `.sh`/`.bash` → `/bin/bash`; else → Python.
- no_agent: stdout (trimmed) delivered verbatim; empty stdout = silent; non-zero exit/timeout = error alert.
- Pre-run gate — emit on script's **last line** to skip the LLM that tick (saves tokens/cost):
  ```json
  {"wakeAgent": false}
  ```
  Optionally pass context: `{"wakeAgent": true, "context": {"new_rows": 5}}`.

### 2.7 Job chaining (`context_from`)

Prior job output is prepended to the next job's prompt. Accepts single ID/name or list (concatenated in order):
```python
cronjob(action="create", prompt="...", schedule="0 7 * * *", name="Collector")
cronjob(action="create", prompt="...", schedule="30 7 * * *", context_from="Collector", name="Triage")
```

### 2.8 Scheduler / gateway

```bash
hermes gateway install               # user service
sudo hermes gateway install --system # Linux boot service
hermes gateway                       # foreground
```
Model: gateway ticks every 60s → loads `~/.hermes/cron/jobs.json` → checks `next_run_at` → runs each due job in a **fresh AIAgent session** → injects attached skills → runs prompt → delivers → updates `next_run_at`. Lock: `~/.hermes/cron/.tick.lock` (no overlap). Output: `~/.hermes/cron/output/{job_id}/{timestamp}.md`. `model`/`provider` stored `null` if unset, resolved from global config at run time.

### 2.9 Cron gotchas

1. **Recursive cron disabled** — cron-run sessions cannot create cron jobs (management tools off inside cron).
2. **Self-contained prompts** — fresh session, no memory; prompt must carry all context not in attached skills.
3. **`workdir` and `profile` jobs run SEQUENTIALLY** (process-global terminal state / `HERMES_HOME` mutation); other jobs stay parallel.
4. `workdir` injects `AGENTS.md`/`CLAUDE.md`/`.cursorrules` and scopes file/terminal tools to that dir.
5. Deleted pinned profile → warning, falls back to current profile.
6. `[SILENT]`-prefixed final response suppresses delivery (still saved locally); failed jobs always deliver.
7. Prompts security-scanned at create/update (injection, credential exfil, invisible Unicode, SSH backdoor).
8. Cron inherits fallback providers + credential-pool rotation. Use `hermes setup --portal` for unattended OAuth refresh.

---

## 3. Skills System

### 3.1 Directories

- **Primary:** `~/.hermes/skills/` (single source of truth), layout `category/skill-name/SKILL.md` (+ optional `references/ templates/ scripts/ assets/`). `.bundled_manifest` tracks seeded skills.
- **External dirs** (config.yaml):
  ```yaml
  skills:
    external_dirs:
      - ~/.agents/skills
      - /home/shared/team-skills
      - ${SKILLS_REPO}/skills
  ```
  Local skills take precedence over external. Missing external dirs are silently skipped.

### 3.2 config.yaml `skills:` keys (verbatim)

```yaml
skills:
  external_dirs:                 # list[str] — extra skill source dirs
    - ~/.agents/skills
  config:                        # per-skill non-secret settings (keys declared in SKILL.md frontmatter)
    myplugin:
      path: ~/myplugin-data
  guard_agent_created: false     # bool, default false. true = scan skill_manage writes for dangerous patterns + prompt approval
  disabled_toolsets:             # list[str] — suppress toolsets globally (CLI + all gateway platforms)
    - memory
    - web
```

**IMPORTANT — there is NO `skills.disabled` per-skill denylist key in the current docs.** Verified across the skills page and the configuration page. The available disable mechanisms are:
- **`skills.disabled_toolsets`** (list) — global toolset suppression. This is the closest "denylist" and the correct key for turning capability groups off via config.
- **`hermes skills uninstall <name>`** — remove an installed hub skill.
- **`hermes skills opt-out`** — stop future bundled-skill seeding (profile-wide); `--remove` deletes *unmodified* bundled skills only.
- **`.no-bundled-skills`** marker file in a profile dir — prevents bundled seeding (does not touch user/hub skills).
- **Conditional activation** in a skill's own frontmatter (`fallback_for_toolsets` / `requires_toolsets` / `*_tools`) — auto-hide a skill based on tool availability.

(If a build target assumes a literal `skills.disabled: [...]` list, that is NOT supported as documented — use `disabled_toolsets`, `uninstall`, or `opt-out`.)

### 3.3 SKILL.md frontmatter (verbatim)

```yaml
---
name: my-skill                         # required, str
description: Brief description          # required, str
version: 1.0.0                          # optional, semver
platforms: [macos, linux]               # optional: macos|linux|windows
metadata:
  hermes:
    tags: [python, automation]          # optional
    category: devops                    # optional
    fallback_for_toolsets: [web]        # show ONLY when toolset unavailable
    requires_toolsets: [terminal]       # show ONLY when toolset available
    fallback_for_tools: [web_search]    # individual-tool version
    requires_tools: [terminal]
    config:                             # optional persisted settings → config.yaml skills.config
      - key: my.setting
        description: "What this controls"
        default: "value"
        prompt: "Prompt for setup"
required_environment_variables:         # optional; prompts on local load; passed to execute_code/terminal as $VAR
  - name: TENOR_API_KEY
    prompt: Tenor API key
    help: Get a key from https://developers.google.com/tenor
    required_for: full functionality
---
# Title
## When to Use / ## Procedure / ## Pitfalls / ## Verification
```

agentskills.io-compatible (progressive disclosure). Skill config setup: `hermes config migrate` (prompts unconfigured), `hermes config show`.

### 3.4 `hermes skills` CLI (verbatim)

```bash
# Bundled-skill seeding control
hermes skills opt-out                 # stop future seeding (profile-wide)
hermes skills opt-out --remove        # + delete UNMODIFIED bundled skills
hermes skills opt-in --sync           # re-enable + reseed
hermes skills reset <name>            # clear modified flag
hermes skills reset <name> --restore  # restore pristine upstream version
hermes skills reset <name> --restore --yes

# Hub browse/search/install
hermes skills browse [--source official]
hermes skills search <q> [--source skills-sh|official]
hermes skills inspect <owner/path>
hermes skills install <ref> [--force] [--name <alias>]
#   refs: official/security/1password | openai/skills/k8s | skills-sh/.../x
#         well-known:https://host/.well-known/skills/x | https://host/SKILL.md
hermes skills list [--source hub]
hermes skills check                   # check upstream updates
hermes skills update [<name>]
hermes skills audit                   # re-scan security
hermes skills uninstall <name>

# Taps (GitHub registries)
hermes skills tap add <owner/repo>
hermes skills tap list
hermes skills tap remove <owner/repo>

# Query at runtime
hermes chat --toolsets skills -q "What skills do you have?"
```

Install-time opt-out: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --no-skills`. Profile create: `hermes profile create research --no-skills`.

In-chat: `/skills browse|search|install|list|reset|tap ...`, `/<skillname> <request>` to load a skill (e.g. `/plan ...`).

### 3.5 Bundles

```bash
hermes bundles create <slug> --skill A --skill B -d "desc"
hermes bundles list|show <slug>|delete <slug>|reload
```
YAML at `~/.hermes/skill-bundles/<slug>.yaml`:
```yaml
name: backend-dev          # optional (defaults to filename)
description: ...           # optional
skills:                    # required, non-empty
  - github-code-review
  - test-driven-development
instruction: |            # optional, prepended guidance
  Always start by writing failing tests, then implement.
```
Bundles take precedence over individual skills on slug collision; missing skills skipped (non-fatal). In-chat `/bundles`.

### 3.6 Progressive disclosure (token tiers)

`skills_list()` (~3k tokens: name/description/category) → `skill_view(name)` (full) → `skill_view(name, path)` (one reference file). Agent-managed via `skill_manage(create|patch|edit|delete|write_file|remove_file)` — auto-creates skills after complex tasks (5+ tool calls).

### 3.7 Media output directives

Bare absolute media paths auto-deliver natively. `path[[as_document]]` → send all images in response as documents. `path[[audio_as_voice]]` → send mp3 as voice message. Directives stripped before delivery.

### 3.8 Skills gotchas

1. `opt-out` never deletes anything; `--remove` deletes only *unmodified* bundled skills.
2. Local skill name beats external-dir same-name.
3. GitHub hub: 60 req/h unauth → set `GITHUB_TOKEN` in `.env` for 5,000/h.
4. Manually copying bundled skills back won't update origin hash — use `hermes skills reset` to re-baseline.
5. Trust levels: `builtin` > `official` > `trusted` (openai/anthropics/huggingface) > `community`. `--force` overrides non-dangerous findings only (never `dangerous`).
6. Non-default tap path: edit `~/.hermes/.hub/taps.json` → `{"taps":[{"repo":"org/repo","path":"internal/skills/"}]}`.

---

## 4. Quick-reference env vars

| Var | Purpose | Location |
|-----|---------|----------|
| `HERMES_CRON_SCRIPT_TIMEOUT` | override cron pre-run script timeout | env |
| `TELEGRAM_CRON_THREAD_ID` | Telegram topic thread for cron delivery | `.env` |
| `TELEGRAM_HOME_CHANNEL` | Telegram home channel | `.env` |
| `GITHUB_TOKEN` | raise skills-hub GitHub rate limit to 5k/h | `.env` |
| `FIRECRAWL_API_KEY` | activates `web` toolset (hides fallback web skills) | `.env` |
| `HERMES_HOME` | profile root resolved by scheduler for `--profile` jobs | env |
