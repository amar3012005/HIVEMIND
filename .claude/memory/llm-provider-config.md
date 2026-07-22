# Canonical LLM provider config — the ONE source of truth

_Established 2026-07-22 (owner directive: "one canonical ground truth for the LLM api key;
only at that place we define api reference and model; no Groq, no llama")._

## The rule
There is exactly ONE place that defines the LLM key + endpoint + model:
**`core/src/llm/llm-config.js`**. Nothing else may define a provider key, base URL,
or model for chat completions. If you need to change provider/model, change env
consumed by that file — never a call site.

## How it works (chokepoint, not a 30-file rewrite)
- `server.js` installs a **global fetch wrap** (~line 69) that intercepts every
  `api.groq.com/.../chat/completions` call and routes it through `groqFetch`
  (`core/src/llm/groq-fallback.js`). ~25 historical call sites hardcode the Groq
  URL + a per-site model id (many were `llama-3.3-70b-versatile` /
  `llama-3.1-8b-instant`). Those model ids are now **ignored** — the chokepoint
  forces the canonical model.
- `groqFetch` reads `activeProviders()` from `llm-config.js` and routes:
  **Cerebras (primary) → OpenRouter (failover)**, model **`gpt-oss-120b`**.
  No Groq for text. No llama.
- All four load-bearing callers (chat `react-agent-v2`, recall synthesis
  `persisted-retrieval`, ingestion `document-first-ingestion`, TARA
  `stream-handler`) hit `api.groq.com` → so the chokepoint governs them all.

## Key facts / gotchas (verified live 2026-07-22)
- **gpt-oss-120b is a REASONING model.** Output can land in `message.reasoning`;
  at low `max_tokens` the whole budget goes to reasoning and `content` is empty.
  Fix: canonical body sets **`reasoning_effort: 'low'`** by default
  (`LLM_REASONING_EFFORT`) so short classification/judge calls still return
  content. `groqFetch` also coalesces `reasoning → content`.
- **Cerebras wants the BARE model id** (`gpt-oss-120b`); a namespaced id
  (`openai/gpt-oss-120b`) 404s. `LLM_MODEL` is currently set to
  `openai/gpt-oss-120b`, so `llm-config` maps per provider: Cerebras strips the
  namespace → bare; OpenRouter keeps/forces `openai/`. Robust to either env form.
- **Cerebras endpoint:** `https://api.cerebras.ai/v1/chat/completions`,
  OpenAI-compatible, Bearer `CEREBRAS_API_KEY`. Tool-calling + streaming both work.
  Latency ~312ms vs ~1034ms via OpenRouter → Cerebras primary is the low-latency win.
- **Do NOT send OpenRouter's `provider` routing object to Cerebras** (it errors) —
  `llm-config` gates it via `supportsProviderPrefs`.
- **Audio/vision/websearch pass through unchanged**: models matching
  `compound|whisper|vision|tts|guard|parakeet|moderation|embed` are NOT
  canonicalized (no gpt-oss equivalent) — they stay on their original path.
- **Metering topology preserved**: metered in `memoryChatFetch`/litellm/planEnforcer,
  NOT in the chokepoint (avoids double-count of the monkeypatched sites).

## Env knobs (all read only by llm-config.js)
`LLM_MODEL` (default gpt-oss-120b) · `LLM_REASONING_EFFORT` (low) ·
`LLM_PROVIDER_ORDER` (cerebras,openrouter) · `CEREBRAS_API_KEY` · `CEREBRAS_BASE_URL` ·
`OPENROUTER_API_KEY` · `OPENROUTER_BASE_URL`. `LLM_PRIMARY`/`GROQ_*` are now legacy/no-op for text.

## Residual (inert, follow-up only)
- ~20 call sites still hardcode a `llama-*` default model string, but those values
  are **overridden by the chokepoint** (dead). A mechanical cleanup can replace them
  to read `CANONICAL_MODEL`, but it changes no behavior. Not urgent.
- `GROQ_API_KEY` remains in env; harmless (text never routes to Groq now). Non-text
  Groq endpoints (STT/vision/websearch) still use it by design.
