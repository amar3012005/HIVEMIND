# Hermes Agent — MCP Configuration (Technical Reference)

Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp

This is a distilled, build-critical reference for wiring MCP servers into Hermes agents
programmatically — no custom hacks. Config lives in `config.yaml`; secrets resolve from
env / `~/.hermes/.env` at connect time.

---

## 1. config.yaml — `mcp_servers` (EXACT key + structure)

Top-level key is **`mcp_servers`**, a map of `<server_name> -> server config`.
There is **NO `transport:` nesting block** — `command`/`args`/`url`/`headers` etc. are
**direct children** of the server name. Transport is inferred from which keys are present
(`command` => stdio; `url` => HTTP).

```yaml
mcp_servers:
  <server_name>:
    # --- Transport (pick stdio OR http) ---
    command: "npx"                 # stdio: executable
    args: ["-y", "pkg", "--flag"]  # stdio: argv
    env:                           # stdio: env vars passed to subprocess
      KEY: "value"

    url: "https://mcp.example.com" # http: remote endpoint
    headers:                       # http: request headers
      Authorization: "Bearer ${MY_TOKEN}"

    # --- Auth (http) ---
    auth: oauth                    # OAuth 2.1 flow (run `hermes mcp login <server>`)
    client_cert: "~/.certs/c.pem"  # mTLS (see formats below)
    client_key: "~/.certs/c.key"

    # --- Connection behavior ---
    timeout: 30                    # per tool-call timeout (s)
    connect_timeout: 30            # initial connect timeout (s)

    # --- Runtime control ---
    enabled: true                  # enable/disable this server
    supports_parallel_tool_calls: false  # only true for read-only/race-safe tools

    # --- Tool filtering ---
    tools:
      include: [tool1, tool2]      # whitelist; WINS over exclude if both set
      exclude: [tool3]             # blacklist
      resources: true              # enable list_resources/read_resource utilities
      prompts: true                # enable list_prompts/get_prompt utilities

    # --- Sampling (server-initiated LLM calls) ---
    sampling:
      enabled: true
      model: "openai/gpt-4o"
      max_tokens_cap: 4096
      timeout: 30
      max_rpm: 10
      max_tool_rounds: 5
      allowed_models: []
      log_level: "info"
```

### Canonical verbatim example (from the docs)

```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "***"
    tools:
      include: [create_issue, list_issues, search_code]
      prompts: false
```

---

## 2. Environment variable substitution

- **Syntax:** `${VAR_NAME}`
- **Resolved at server-connect time** in: `command`, `args`, `url`, `headers`.
- **Sources:** system environment, `~/.hermes/.env` file.
- **Special token:** `${INSTALL_DIR}` — valid only at catalog install-time.

```yaml
mcp_servers:
  api:
    url: "https://mcp.example.com"
    headers:
      Authorization: "Bearer ${MY_TOKEN}"
```

Stdio env is filtered: only the configured `env` block + a safe baseline are passed to the
subprocess (NOT the full shell environment).

---

## 3. Transports

| Transport  | Keys                                  | Notes |
|------------|---------------------------------------|-------|
| Stdio      | `command`, `args`, `env`              | local subprocess over stdin/stdout |
| HTTP       | `url`, `headers`                      | remote endpoint |
| OAuth HTTP | `url`, `auth: oauth`                  | OAuth 2.1; finish with `hermes mcp login <server>` |
| mTLS HTTP  | `url`, `client_cert`, `client_key`    | client-cert auth |

mTLS cert formats:

```yaml
client_cert: "~/.certs/mcp-client.pem"                                   # combined PEM
client_cert: ["~/.certs/mcp-client.crt", "~/.certs/mcp-client.key"]      # separate cert+key
client_cert: ["~/.certs/mcp-client.crt", "~/.certs/mcp-client.key", "${MCP_KEY_PASSWORD}"]  # encrypted key
```

---

## 4. Tool filtering (`tools.include` / `tools.exclude`)

```yaml
tools:
  include: [create_issue, list_issues]   # whitelist
  exclude: [delete_customer]             # blacklist
  prompts: false                         # disable list_prompts/get_prompt
  resources: false                       # disable list_resources/read_resource
```

- **Precedence:** if both present, `include` wins.
- Filter names use the **bare server-side tool name** (NOT the `mcp_<server>_` prefixed name).
- If filtering removes every tool, no runtime toolset is created for that server.

---

## 5. Tool naming convention

Pattern: **`mcp_<server_name>_<tool_name>`**. Hyphens/dots in names are normalized to `_`.

- server `filesystem`, tool `read_file`  -> `mcp_filesystem_read_file`
- server `github`, tool `create-issue`   -> `mcp_github_create_issue`
- server `my-api`, tool `query.data`      -> `mcp_my_api_query_data`

Per-server utility tools: `mcp_<server>_list_resources`, `mcp_<server>_read_resource`,
`mcp_<server>_list_prompts`, `mcp_<server>_get_prompt`.

---

## 6. CLI commands (verbatim)

```bash
hermes mcp                       # interactive picker (default)
hermes mcp catalog               # plain-text list, scriptable
hermes mcp install n8n           # install a catalog entry by name
hermes mcp add codex --preset codex   # add a custom server from a preset
hermes mcp configure <server>    # re-open tool selection for a server
hermes mcp login <server>        # complete OAuth flow for a server
hermes mcp serve                 # run Hermes itself as an MCP server
hermes mcp serve --verbose       # debug logging
hermes auth <provider>           # authenticate a third-party provider
```

`hermes mcp add` form: `hermes mcp add <server_name> --preset <preset>` (documented preset: `codex`).
In-session reload: the **`/reload-mcp`** slash command.

---

## 7. Gotchas

1. **OAuth on headless hosts:** use paste-back flow or SSH port-forward
   (`ssh -N -L <port>:127.0.0.1:<port>`).
2. **DCR-less providers** (Google Drive, Atlassian): auto-registration fails — supply a
   pre-registered `client_id`/`client_secret`.
3. **Config auto-reload race:** the 30s reload timeout is too short for interactive OAuth.
   Edit config, then run `hermes mcp login <server>` from a fresh terminal.
4. **Empty filters:** if `include`/`exclude` remove all tools, that server contributes none.
5. **Parallel calls:** only set `supports_parallel_tool_calls: true` for read-only, race-safe tools.
6. **Stdio env is whitelisted:** only `env` block + safe baseline reach the subprocess.
7. **Dynamic discovery:** servers may push `notifications/tools/list_changed`; Hermes
   auto-refreshes the toolset (no manual reload needed).
