# Hermes Agent — Configuration Reference

**Source:** https://hermes-agent.nousresearch.com/docs/user-guide/configuration

This is a distilled technical reference for configuring Hermes agents programmatically. Exact keys, defaults, CLI commands, env vars, and gotchas.

---

## ~/.hermes Directory Layout

```
~/.hermes/
├── config.yaml      # Settings (model, terminal, TTS, compression, etc.)
├── .env             # API keys and secrets (ONLY place for credentials)
├── auth.json        # OAuth provider credentials
├── SOUL.md          # Primary agent identity
├── memories/        # Persistent memory (MEMORY.md, USER.md)
├── skills/          # Agent-created skills
├── cron/            # Scheduled jobs
├── sessions/        # Gateway sessions
└── logs/            # Logs (errors.log, gateway.log)
```

## Configuration Precedence (highest → lowest)

1. **CLI arguments** — e.g. `hermes chat --model anthropic/claude-sonnet-4`
2. **`~/.hermes/config.yaml`**
3. **`~/.hermes/.env`** — fallback for env vars; REQUIRED for secrets
4. **Built-in defaults**

**Rule:** Secrets go in `.env`; everything else in `config.yaml`.

## CLI Commands

```bash
hermes config              # View current configuration
hermes config edit         # Open config.yaml in editor
hermes config set KEY VAL  # Set specific value
hermes config check        # Check for missing options
hermes config migrate      # Interactively add missing options
hermes setup --portal      # OAuth setup via Nous Portal
hermes model               # Interactive model/auxiliary config picker
hermes auth                # OAuth authentication
hermes tools               # Enable/disable toolsets
hermes doctor              # Diagnostic checks
hermes chat --model PROVIDER/MODEL   # Override model for one run (CLI > config)
```

---

## config.yaml — Full Structure

### Model

```yaml
model:
  default: anthropic/claude-opus-4
  provider: anthropic
  # OR custom endpoint:
  # provider: custom
  # base_url: https://api.example.com/v1
  # api_key: sk-...
  context_length: 200000          # hot-reloads (no restart)
```

### Terminal Backend

```yaml
terminal:
  backend: local                  # local|docker|ssh|modal|daytona|singularity
  cwd: "."
  timeout: 180
  env_passthrough: []
  persistent_shell: true          # SSH default true; Local default false

  # Docker-specific
  docker_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  docker_mount_cwd_to_workspace: false
  docker_run_as_host_user: false
  docker_forward_env: ["GITHUB_TOKEN"]
  docker_env: {DEBUG: "1"}
  docker_volumes: ["/host:/container"]
  docker_extra_args: ["--gpus=all"]
  docker_persist_across_processes: true
  docker_orphan_reaper: true
  container_cpu: 1
  container_memory: 5120
  container_disk: 51200
  container_persistent: true
  lifetime_seconds: 300

  # SSH: TERMINAL_SSH_HOST, TERMINAL_SSH_USER required as env vars
  # Optional: TERMINAL_SSH_PORT, TERMINAL_SSH_KEY

  modal_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  daytona_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  singularity_image: "docker://nikolaik/python-nodejs:python3.11-nodejs20"

  file_sync_max_mb: 100
  file_sync_enabled: true
```

### Auxiliary Models (vision, compression, web extract, etc.)

```yaml
auxiliary:
  vision:
    provider: "auto"              # auto|openrouter|nous|codex|main
    model: "openai/gpt-4o"
    base_url: ""
    api_key: ""
    timeout: 120
    download_timeout: 30
  web_extract:
    provider: "auto"
    model: ""
    timeout: 360
  compression:
    provider: "auto"
    model: ""
    timeout: 120
  approval:
    provider: "auto"
    timeout: 30
  # Also: skills_hub, mcp, triage_specifier (same block shape)
```

### Memory

```yaml
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
```

### Context Compression

```yaml
compression:
  enabled: true
  threshold: 0.50                 # compress at 50% of context limit (% not absolute)
  target_ratio: 0.20
  protect_last_n: 20
  protect_first_n: 3
  hygiene_hard_message_limit: 400 # hot-reloads (no restart)
```

### Agent Behavior

```yaml
agent:
  max_turns: 90
  api_max_retries: 3
  disabled_toolsets: [memory, web]
  reasoning_effort: ""            # ""=medium | minimal|low|high|xhigh
  tool_use_enforcement: "auto"    # auto|true|false|["gpt","codex"]
```

### Tool Output / File Read Limits

```yaml
file_read_max_chars: 100000

tool_output:
  max_bytes: 50000
  max_lines: 2000
  max_line_length: 2000
```

### Display / Output

```yaml
display:
  tool_progress: all              # off|new|all|verbose
  tool_progress_command: false
  platforms:
    signal:
      tool_progress: 'off'
    telegram:
      tool_progress: verbose
  interim_assistant_messages: true
  skin: default
  personality: "kawaii"
  compact: false
  resume_display: full
  bell_on_complete: false
  show_reasoning: false
  streaming: false
  show_cost: false
  timestamps: false
  tool_preview_length: 0
  runtime_footer:
    enabled: false
    fields: ["model", "context_pct", "cwd"]
  file_mutation_verifier: true
  language: en
```

### Speech / Voice

```yaml
tts:
  provider: "edge"                # edge|elevenlabs|openai|minimax|mistral|gemini|xai|neutts
  speed: 1.0
  edge:
    voice: "en-US-AriaNeural"
    speed: 1.0
  elevenlabs:
    voice_id: "pNInz6obpgDQGcFmaJgB"
    model_id: "eleven_multilingual_v2"
  openai:
    model: "gpt-4o-mini-tts"
    voice: "alloy"
    speed: 1.0
    base_url: "https://api.openai.com/v1"

stt:
  provider: "local"               # local|groq|openai|mistral
  local:
    model: "base"                 # tiny|base|small|medium|large-v3
  openai:
    model: "whisper-1"

voice:
  record_key: "ctrl+b"
  max_recording_seconds: 120
  auto_tts: false
  beep_enabled: true
  silence_threshold: 200
  silence_duration: 3.0
```

### Streaming (Gateway)

```yaml
streaming:
  enabled: true
  transport: edit                 # edit|off
  edit_interval: 0.3
  buffer_threshold: 40
  cursor: " ▉"
  fresh_final_after_seconds: 60
```

### Web Search

```yaml
web:
  backend: firecrawl              # firecrawl|searxng|parallel|tavily|exa
  search_backend: "searxng"
  extract_backend: "firecrawl"
```

### Browser

```yaml
browser:
  inactivity_timeout: 120
  command_timeout: 30
  record_sessions: false
  cdp_url: ""
  dialog_policy: must_respond     # must_respond|auto_dismiss|auto_accept
  dialog_timeout_s: 300
  camofox:
    managed_persistence: false
    user_id: ""
    session_key: ""
    adopt_existing_tab: false
```

### Code Execution

```yaml
code_execution:
  mode: project                   # project|strict
  timeout: 300
  max_tool_calls: 50
```

### Security / Approvals

```yaml
security:
  redact_secrets: true
  tirith_enabled: true
  tirith_path: "tirith"
  tirith_timeout: 5
  tirith_fail_open: true
  website_blocklist:
    enabled: false
    domains: ["*.internal.company.com"]
    shared_files: ["/etc/hermes/blocked-sites.txt"]

approvals:
  mode: manual                    # manual|smart|off  (HERMES_YOLO_MODE = off)
```

### Skills

```yaml
skills:
  config:
    myplugin:
      path: ~/myplugin-data
  guard_agent_created: false
```

### Providers — Timeouts, Fallbacks, Credential Pools

```yaml
providers:
  openrouter:
    request_timeout_seconds: 1800
    stale_timeout_seconds: 300
    models:
      openai/gpt-4o:
        timeout_seconds: 900
        stale_timeout_seconds: 180

fallback_providers:
  - provider: openrouter
    model: google/gemini-2.5-flash
    timeout: 30
  - provider: nous
    model: ""

credential_pool_strategies:
  openrouter: round_robin         # fill_first|round_robin|least_used|random
  anthropic: least_used
```

### Misc Top-Level Settings

```yaml
group_sessions_per_user: true
unauthorized_dm_behavior: pair    # pair|ignore

discord:
  require_mention: true
  free_response_channels: ""
  auto_thread: true

quick_commands:
  status:
    type: exec
    command: systemctl status hermes-agent
  restart:
    type: alias
    target: /gateway restart

human_delay:
  mode: "off"                     # off|natural|custom
  min_ms: 800
  max_ms: 2500

privacy:
  redact_pii: false

timezone: "America/New_York"      # IANA timezone or ""
worktree: true                    # auto-create git worktrees

updates:
  pre_update_backup: false
  backup_keep: 5
  non_interactive_local_changes: stash   # stash|discard

context:
  engine: "compressor"

checkpoints:
  enabled: false
  max_snapshots: 20
```

---

## Environment Variable Substitution in config.yaml

Syntax: `${VAR_NAME}` ONLY. Bare `$VAR` is NOT expanded. Undefined vars stay verbatim.

```yaml
auxiliary:
  vision:
    api_key: ${GOOGLE_API_KEY}
    base_url: ${CUSTOM_VISION_URL}
```

## Environment Variables (place secrets in ~/.hermes/.env)

**Secrets / API keys:** `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `DAYTONA_API_KEY`, `TERMINAL_SSH_HOST`, `TERMINAL_SSH_USER`, `GROQ_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`

**Terminal overrides:** `TERMINAL_DOCKER_IMAGE`, `TERMINAL_DOCKER_FORWARD_ENV='["VAR1","VAR2"]'`, `TERMINAL_DOCKER_ENV='{"KEY":"value"}'`, `TERMINAL_DOCKER_VOLUMES='["/host:/container"]'`, `TERMINAL_DOCKER_EXTRA_ARGS='["--gpus=all"]'`, `TERMINAL_DOCKER_RUN_AS_HOST_USER`, `TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES`, `TERMINAL_DOCKER_ORPHAN_REAPER`, `TERMINAL_CONTAINER_CPU`, `TERMINAL_CONTAINER_MEMORY`, `TERMINAL_CONTAINER_DISK`, `TERMINAL_CONTAINER_PERSISTENT`, `TERMINAL_LIFETIME_SECONDS`, `TERMINAL_TIMEOUT`, `TERMINAL_SSH_PORT`, `TERMINAL_SSH_KEY`, `TERMINAL_SSH_PERSISTENT`, `HERMES_DOCKER_BINARY`

**Speech/Audio:** `STT_GROQ_MODEL`, `STT_OPENAI_MODEL`, `GROQ_BASE_URL`, `STT_OPENAI_BASE_URL`, `VOICE_TOOLS_OPENAI_KEY`

**Other:** `HERMES_LANGUAGE`, `HERMES_FILE_MUTATION_VERIFIER`, `HERMES_STREAM_READ_TIMEOUT`, `HERMES_STREAM_STALE_TIMEOUT`, `HERMES_API_TIMEOUT`, `HERMES_API_CALL_STALE_TIMEOUT`, `HERMES_YOLO_MODE` (= `approvals.mode: off`)

---

## Gotchas

1. **YAML duplicate keys** — later keys silently override earlier ones.
2. **Secrets vs settings** — only `.env` should hold credentials; never put keys in `config.yaml` (except via `${VAR}` substitution).
3. **Local backend has no sandbox** — agent has full user filesystem access. Use `docker`/`ssh`/`modal`/`daytona`/`singularity` for isolation.
4. **Docker persistence** — a single container is shared across sessions by default (`docker_persist_across_processes: true`).
5. **Compression threshold is a fraction** — `compression.threshold` fires at a % of the context window, not an absolute token count.
6. **Vision aux model must be multimodal** — non-multimodal models fail vision tasks.
7. **Prompt caching is always-on** when the provider supports it; there is no disable knob.
8. **Gateway hot-reload** — `model.context_length` and `compression.*` take effect on the next message without a restart; most other keys need a gateway restart.
9. **`${VAR}` only** — bare `$VAR` is not interpolated; undefined `${VAR}` stays literal in the merged config.
