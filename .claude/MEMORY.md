# Claude Memory Log — HIVE-MIND

Running log of decisions, actions, implementations across Claude sessions. Append a dated
entry after each meaningful task. Newest at top within a date. Pair with
`.claude/INSTRUCTIONS.md`.

---

## 2026-05-30

### CSI / MiroFish + Employees architecture docs
- Wrote `CSI_MIROFISH.md` (root): prompt->ontology->graph->agents->config->CSI rounds->report
  pipeline + single-round sequence diagram + artifact schema. Source: MiroFish/backend.
- Wrote `DIGITAL_EMPLOYEES_AND_HYPER_AGENTS.md` (root): full functionality + architecture.
  Node control-plane + Python employees-service (FastAPI :8060), shared Postgres,
  AgentScope ReAct, R1-R5 swarm phase machine.

### Architectural finding (HyperAgents vs CSI)
- Crucial gap: HyperAgents has NO persistent, queryable, provenance-linked CLAIM/TRIAL
  artifact graph. Debate lives in `HyperTurn.lines[]` (transcript in one row); only final
  decision saved to memory -> reasoning graph discarded.
- MiroFish CSI = first-class durable artifacts, concurrent agents (ThreadPool 8), evidence-
  grounded confidence recompute, source/web-ingest loop, accumulate + synthesize.
- Recommended (NOT implemented): persistent CSI artifact layer behind HyperAgents + concurrent
  execution. Explicitly WITHOUT token caps/seals (user constraint).

### Maintenance setup
- Created `.claude/INSTRUCTIONS.md` + `.claude/MEMORY.md`. Update MEMORY per task,
  INSTRUCTIONS when rules emerge.

## 2026-05-29

### i18n coverage
- OSS verdict: already best stack (i18next + react-i18next) + runtime Groq auto-translate;
  gap was COVERAGE. Wired `t()` into 34 pages (keyed+default, ns 'dashboard'); skipped 2
  string-less graph renderers. Toggle+RTL already correct (src/i18n.js + LangSwitcher ->
  hivemind:lang). Verified all 41 pages parse + full react-scripts build exit 0. Workflow
  blocked -> ran as 10 parallel Agent batches.

### Chat.jsx redesign
- Restyled slide-in chat panel (glass header, scope pill, gradient bubbles, focus-glow
  composer, suggestion chips wired to existing setInput). Logic/exports preserved. +101 lines.

### Walkthrough cards
- `app/shared/Walkthrough.jsx` + useWalkthrough gating + DEFAULT_STEPS. Wired into AppShell
  (first-run gated). Verified via ui-preview skill.

### Transactional email (Gmail-over-Nango)
- Decision: NOT Gmail MCP (session-bound). Use enterprise Gmail via Nango google-mail send.
  Built core/src/email/{templates.json, email-service.js} (sendSystemEmail, never throws,
  429/5xx retry, HTML-escaped). Route POST /v1/notifications/welcome (session user only,
  once/session). Overview.jsx fires once/session. Pending: connect mailbox + set
  SYSTEM_EMAIL_NANGO_CONNECTION_ID. No-ops until set.

### Global skills
- ~/.claude/skills/ui-preview/ — isolated React screenshots (Tailwind CDN + esm.sh + babel
  + Python Playwright; multiline-import fix; greenlet user-site escape).
- ~/.claude/skills/web-search/ — Tavily via blaiq LiteLLM gateway. Blocked on gateway's
  invalid Tavily provider key (set valid tvly-... in LiteLLM UI). LITELLM_API_KEY in ~/.zshrc.

### SEO/GEO (open)
- Applied JSON-LD (Org sameAs, FAQPage), llms.txt, sitemap, robots AI-bot allows,
  react-helmet per-route meta. react-snap prerender FAILED (Chromium not downloaded) ->
  build green but no prerendered HTML. Decision pending: fix react-snap vs Vercel edge.
