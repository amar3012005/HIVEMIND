# Autonomous Goal Queue

The loop works these **top-to-bottom, one at a time**. While any `[ ]`/`[~]` goal
remains, the Stop hook (`.claude/hooks/goal-loop-stop.py`) blocks the session from
ending and re-injects the current goal — so "keep going" is the default.

Status: `[ ]` pending · `[~]` in progress · `[x]` shipped+verified · `[!]` blocked (needs human → pauses the loop)

**FE per-goal pipeline** (Da-vinci submodule, deploys via Vercel): fix → `npm run build`
(CI=true, must be clean) → ui-preview screenshot the changed page → commit (author
amarsai3012005) in `frontend/Da-vinci` + bump the submodule pointer → mark `[x]`. Theme
bar = `~/.claude/skills/hivemind-frontend` (light ivory #faf9f4, ONE accent #117dff,
Space Grotesk headings/numbers only, rounded-[10px] cards / [6px] controls, no
purple/violet, no dark surfaces, near-zero shadow).

---

## Queue — HIVEMIND app feature polish (from the 5-agent red-team, 2026-06-19)

### Shipping-blocker bugs (fix first)
- [ ] **Memories.jsx** — remove the duplicate data-fetch layer (parent `Memories()` ~911-1147 re-runs listMemories+quickSearch the child already does → double network requests every filter change); fix off-token low-contrast badges (181-184, 280: `text-*-400/70` → 600/700); drop redundant page bg/padding (1152 `min-h-screen bg-[#faf9f4]`); guard `Invalid Date` (2304,2462); fix `contradictions` tab link (1262) or remove.
- [ ] **HyperAgents.jsx** — fix malformed Tailwind `rounded-none-[24px]` (2841) + `rounded-none-[20px]` (3116) → real radii (modals render 0px corners now). Confirm sharp-corner intent vs design.
- [ ] **DigitalEmployees.jsx** — guard `employee.model.split` crash (450 → `(employee.model||'').split`); guard `renderInline` link match (1561); cap/stop the 2.5s transcript poll (545-569); flatten dark code-block surface (1575,1588) + blue gradient canvas (820).
- [ ] **Settings.jsx** — owner locked out of Project Access Policy (331 gate `=== 'admin'` → also `'owner'`); surface save/revoke errors (162-179 silent `catch{}`); fix dead docs domain `docs.hivemind.dev` → canonical (504,513).
- [ ] **Billing.jsx** — wrong "Graph Queries" limit (540 uses `searches`); annual toggle mischarges (cosmetic −20% but checkout sends monthly — wire `billingCycle` or remove); alert()+console → inline errors (419-432); numeric price in PLANS not `parseInt(replace('€'))`.
- [ ] **WebIntelligence.jsx** — i18n renders `[object Object]` (908: JSX passed as interpolation value → plain string); align radii `rounded-xl`→`[10px]` + H1 recipe; surface silent save errors (248-313); a11y label/htmlFor on crawl inputs.

### Theme hard-rule violations (purple/violet/off-shell)
- [ ] **WebStudio.jsx** — scope SINGULANCE serif/Google-Fonts + 2nd accent (#1a45c4/violet) to the NEW-TAB report only; in-app `ResearchPreviewModal` must use theme tokens (no external `@import` into the live app, 112-164,989); re-map violet research/crawl accents → #117dff (768-1164); fix `LiveResearchPanel` auto-scroll no-op (757 — ref on non-scroller); whitelist `https?:` in `mdToHtml` link href (1603).
- [ ] **AgentSwarm.jsx** — remove violet/purple gradient + badges (29-31,691,930 `from-violet-500 to-purple-500`) → sanctioned blue/amber/emerald; alert()/confirm → in-page toast (flash) + one styled confirm for bulk-delete; `font-bold`→`font-semibold` (369,490); emoji→lucide icons; clear poll intervals before reassign (117-124).
- [ ] **TaraConfig.jsx** — recolor purple→#117dff + flatten glassmorphism skill-card tiles (107-546); delete ~270 lines of dead eslint-disabled components (ConfigEditor/LiveTest/ActiveSessions, 39-504); guard `startedAt` dates (772-853); surface silent load errors (765-768); H1 → `text-[24px] font-semibold`.
- [ ] **KnowledgeBase.jsx** — normalize radii (`rounded-2xl/xl`→`[10px]`, controls `[6px]`) + soften shadows; H1+section heads to design recipe + drop Space Grotesk on body; map `TYPE_COLORS.general` gray→warm neutrals, drop violet enterprise badge (227,1490,1847); a11y labels on bulk checkboxes + delete btn (1930-2069); remove console.log (2150).
- [ ] **Profile.jsx** — avatar `from-[#117dff] to-[#6366f1]` gradient + `shadow-lg` → solid #117dff flat (135); surface fact edit/delete errors + remove console.error (747,759); fix "Edit Profile Facts" collapsing the open editor (1256,1315).
- [ ] **Engine.jsx** — drive the "all features active" status bar from real state or label it a static legend (614-630, currently lies); rename `t` shadow in SwarmActivity maps (365,372); inline error states instead of console.error-only (71-331); confirm step on destructive synthesize-now "Run now" (443).

### Polish / cleanup / smaller bugs
- [ ] **Connectors.jsx** — fix Nango-only scope-change dead path (803-820 gate `oauthProvider||nangoProvider` but onChangeScope wired only on oauthProvider → Settings save silently no-ops for Salesforce/Linear); alert()/confirm → themed toast/modal (esp. destructive Gmail flush 1146); env-source hardcoded URLs (360,2376,2910); remove console.* (1096-3760); off-token badges (436-446) → #117dff/amber-600; delete dead exports (StatsRow/CopyButton/CONNECTOR_CATEGORIES).
- [ ] **MemoryMoss.jsx** — wire `onSelectMemory` (MemoryGraph passes it 1418 but Moss ignores → leaf-node click does nothing); render or remove dead `subtitle`/`hubLeaves` props (224-235).
- [ ] **MeetingNotes.jsx** — gate `MeetingIntelligencePanel` to the Summary tab only (1202 renders on Notes/Transcript too).
- [ ] **ApiKeys.jsx + McpServer.jsx** — drop off-shell `min-h-screen bg-… p-…` double-bg (ApiKeys 332, McpServer 1171); normalize radii to design system; wrap `handleRevoke` in try/catch (ApiKeys 324, floating promise); remove McpServer 200-line `display:none` dead Quick-Setup block (1305-1501).
- [ ] **Overview.jsx** — robust chat height (1056 drop magic `calc(100vh-104px)`); tone the oversized bold clock to match stat hierarchy (65); remove stray console.warn.
- [ ] **MemoryGraph.jsx** — remove the permanently-dead `{false && (...)}` temporal panel + its orphaned rAF/state (947-999, 1517-1664) OR re-enable it; remove eslint-disabled unused imports (14-21).

## Done (archive — newest first)
<!-- the agent moves [x] goals here with their commit sha -->
