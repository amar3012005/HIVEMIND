# Hermes Agent — Models & Providers (Technical Reference)

**Sources:** https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models · https://hermes-agent.nousresearch.com/docs/integrations/ · authoritative `cli-config.yaml.example` from https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cli-config.yaml.example (the docs site renders client-side; the example file is the canonical schema). The `/docs/integrations/ai-providers` deep-link 404s — the working parent is `/docs/integrations/`.

> Config file is `cli-config.yaml` (copy from `cli-config.yaml.example`). Env vars in `.env` (typically `~/.hermes/.env`) take precedence over YAML. No custom hacks below — everything is documented/first-class.

---

## 1. `model:` block — exact schema

```yaml
model:
  # "default" and "model" are both accepted as the key name.
  default: "anthropic/claude-opus-4.6"   # model id; --model flag overrides per-invocation
  provider: "auto"                       # see provider list below; --provider overrides
  # api_key: "your-key-here"             # optional; normally comes from .env
  base_url: "https://openrouter.ai/api/v1"
  # context_length: 131072               # TOTAL window (in+out). Leave unset → auto-detected.
  # max_tokens: 8192                      # OUTPUT cap only. Leave unset → model native ceiling.
  # default_headers:                      # extra HTTP headers on every OpenAI-wire request
  #   User-Agent: "curl/8.7.1"            #   (use to bypass gateways that reject OpenAI SDK UA)
```

Notes:
- `provider: auto` auto-detects from whichever credentials are present.
- For a single run: `--provider <name>` and `--model <id>` CLI flags override the YAML.
- `api_mode` (values `chat_completions` / `responses`) is referenced by the docs site for the OpenAI Responses API; it is NOT present in the canonical example file — most providers infer the wire format. Native Anthropic and Bedrock use their own SDK paths, not OpenAI-wire.

## 2. Provider names + required env vars (from the canonical example file)

| `model.provider` | What it is | Required credential |
|---|---|---|
| `auto` | Auto-detect from credentials (default) | — |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) |
| `anthropic` | Direct Anthropic API | `ANTHROPIC_API_KEY` |
| `openai` / `gemini` | OpenAI; Google AI Studio direct | `OPENAI_API_KEY`; `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `nous` | Nous Portal OAuth | `hermes login` |
| `nous-api` | Nous Portal API key | `NOUS_API_KEY` |
| `openai-codex` | OpenAI Codex (gpt-5.x-codex) | `hermes auth` (OAuth) |
| `copilot` / `copilot-acp` | GitHub Copilot / GitHub Models | `GITHUB_TOKEN` |
| `zai` | z.ai / ZhipuAI GLM | `GLM_API_KEY` |
| `kimi-coding` / `kimi-coding-cn` | Kimi / Moonshot AI | `KIMI_API_KEY` |
| `minimax` / `minimax-cn` | MiniMax global / China | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| `huggingface` | HF Inference | `HF_TOKEN` |
| `nvidia` | NVIDIA NIM / build.nvidia.com | `NVIDIA_API_KEY` |
| `xiaomi` | Xiaomi MiMo | `XIAOMI_API_KEY` |
| `arcee` | Arcee AI Trinity | `ARCEEAI_API_KEY` |
| `ollama-cloud` | Ollama Cloud | `OLLAMA_API_KEY` |
| `kilocode` | KiloCode gateway | `KILOCODE_API_KEY` |
| `azure-foundry` | Microsoft Foundry / Azure OpenAI | API key or Entra ID (`auth_mode: entra_id`) |
| `lmstudio` | LM Studio local | optional `LM_API_KEY`; default `http://127.0.0.1:1234/v1` |
| `custom` | Any OpenAI-compatible endpoint (set `base_url`) | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) |
| `main` | (auxiliary blocks only) reuse the main agent's provider | — |

`custom` aliases: `ollama`, `vllm`, `llamacpp` all map to `custom`.

## 3. Groq (and any other OpenAI-compatible provider) — no custom hacks

Groq is **not** a first-class `model.provider` in Hermes (it appears first-class only as a speech-to-text backend, env `GROQ_API_KEY`). For Groq as an LLM, use the documented `custom` provider — its API is OpenAI-compatible:

```yaml
model:
  provider: "custom"
  default: "llama-3.3-70b-versatile"      # any Groq model id
  base_url: "https://api.groq.com/openai/v1"
```

```bash
# Credential (custom provider reads the OpenAI-wire env vars):
export OPENAI_BASE_URL="https://api.groq.com/openai/v1"
export OPENAI_API_KEY="$GROQ_API_KEY"
```

Or pin it as a reusable alias (aliases resolve before the models.dev catalog, so off-catalog endpoints work):

```yaml
model_aliases:
  groq:
    model: "llama-3.3-70b-versatile"
    provider: custom
    base_url: "https://api.groq.com/openai/v1"
```

For self-hosted/OpenAI-wire gateways that reject the OpenAI SDK User-Agent, set `model.default_headers.User-Agent`.

## 4. Model aliases — short names for `/model`

```yaml
model_aliases:
  opus:
    model: claude-opus-4-6
    provider: anthropic
  qwen:
    model: "qwen3.5:397b"
    provider: custom
    base_url: "https://ollama.com/v1"
```
Short form also accepted: `model.aliases.<name>: provider/model`.

## 5. Auxiliary (side-task) models — exact schema

Lightweight models for vision, web extraction, compression, session search, etc. Default = Gemini Flash via OpenRouter/Nous, auto-detected. Overriding to non-OpenRouter/non-Nous is EXPERIMENTAL.

```yaml
auxiliary:
  vision:
    provider: "auto"        # auto | openrouter | nous | gemini | ollama-cloud | codex | main
    model: ""               # empty → provider default (OpenRouter: google/gemini-3-flash-preview; Nous: gemini-3-flash)
    timeout: 30
    download_timeout: 30
  web_extract:
    provider: "auto"
    model: ""
  session_search:
    provider: "auto"
    model: ""
    timeout: 30
    max_concurrency: 3
    extra_body: {}          # provider-specific OpenAI-compatible body fields, e.g. {enable_thinking: false}
```
- `provider: auto` → best available: OpenRouter → Nous Portal → main endpoint.
- `provider: main` → use the main agent's custom endpoint (`OPENAI_BASE_URL` + `OPENAI_API_KEY`); valid only inside `auxiliary:` (not top-level `model.provider`).
- `provider: codex` → uses `gpt-5.3-codex` (supports vision).

## 6. Per-provider timeouts / per-model overrides

```yaml
providers:
  ollama-local:
    request_timeout_seconds: 300       # API call timeout
    stale_timeout_seconds: 900         # non-streaming stale-call detector
  anthropic:
    request_timeout_seconds: 30
    models:
      claude-opus-4.6:
        timeout_seconds: 600
  openai-codex:
    models:
      gpt-5.4:
        stale_timeout_seconds: 1800
```
Legacy env equivalents (used only when unset): `HERMES_API_TIMEOUT=1800`, `HERMES_API_CALL_STALE_TIMEOUT=300` (native Anthropic 900). NOT wired for AWS Bedrock (boto3 has its own timeouts).

## 7. OpenRouter provider routing & fallback (only when `provider: openrouter`)

```yaml
provider_routing:
  sort: "throughput"                   # "price" (default) | "throughput" | "latency"; or append :nitro to model
  only: ["anthropic", "google"]        # allow-list of OpenRouter provider slugs
  ignore: ["deepinfra", "fireworks"]   # deny-list
  order: ["anthropic", "google", "together"]  # explicit try-order
  require_parameters: true             # require all request params supported
  data_collection: "deny"              # "allow" (default) | "deny"

openrouter:
  response_cache: true                 # default true
  response_cache_ttl: 300              # 1–86400s

# Per-aux-task routing also accepted via extra_body forwarded verbatim:
auxiliary:
  compression:
    provider: openrouter
    extra_body:
      provider: { order: [anthropic, google], sort: throughput }
```
The integrations page also describes "Fallback Providers" (automatic failover to a backup LLM when the primary errors) and per-OpenRouter provider routing; capabilities (vision, streaming, tool use) are auto-detected per provider.

## 8. CLI commands & flags

```bash
hermes setup --portal                 # login to Nous Portal
hermes login                          # Nous Portal OAuth (for provider: nous)
hermes auth                           # OAuth for Codex / Copilot providers
hermes portal info                    # inspect wired config
hermes model                          # interactive provider + model picker
hermes status                         # show current model/provider status

hermes config set model.aliases.fav anthropic/claude-opus-4.6
hermes config show | grep '^model\.'

# In-session slash command (hot-swap; new sessions only for YAML changes):
/model gpt-5.4 --provider openrouter            # session-only
/model gpt-5.4 --provider openrouter --global   # persist to cli-config.yaml

# Per-invocation flags on `hermes`:
--model <id>     --provider <name>
```

## 9. Gotchas

- Editing `model:` in YAML applies to **new sessions only**; use `/model` to hot-swap in an active chat.
- `model: ""` (empty string) = unconfigured sentinel; `hermes setup`/`hermes model` upgrades it to the mapping form.
- Groq/Ollama/vLLM/llama.cpp/LM Studio are OpenAI-compatible → use `provider: custom` (or `lmstudio`) + `base_url`; the `custom` provider authenticates via `OPENAI_API_KEY`/`OPENAI_BASE_URL`.
- `context_length`/`max_tokens` are different: total window vs output cap. Leave both unset unless auto-detection is wrong (common with local servers/proxies that don't expose `/v1/models`).
- There is no `custom_providers:` block in the canonical example file — multiple custom endpoints are expressed as multiple `model_aliases` entries (each with its own `base_url`).
- `provider: main` is auxiliary-only and will not work as a top-level `model.provider`.
- Secrets: bootstrap token lives in `.env`; Bitwarden Secrets Manager (`bws` CLI) is the supported central secret store — other provider keys can rotate there.
