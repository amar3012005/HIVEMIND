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
- [!] **Memories.jsx** — ✅ off-token badges + `Invalid Date` guard (24bcee5) + ✅ off-shell page bg removed (2f6446d, AppShell provides it — confirmed). NEEDS RUNTIME SESSION (can't click-test in loop): remove the parent's duplicate listMemories+quickSearch fetch layer (~911-1147; child is self-contained but the 150-line cut needs a page run+click to verify no regression); fix/remove the dead `contradictions` tab link (1262 — needs a real destination).
- [~] **DigitalEmployees.jsx** — ✅ crash guard (450, 85f4f98) + ✅ renderInline link null/https guard (1561, 24bcee5). REMAINING: cap/stop the 2.5s transcript poll (545-569); flatten dark code-block surface (1575,1588) + blue gradient canvas (820).
- [~] **Settings.jsx** — ✅ owner role-gate fixed (331, shipped 85f4f98). REMAINING: surface save/revoke errors (162-179 silent `catch{}`); fix dead docs domain `docs.hivemind.dev` → canonical (504,513).
- [!] **Billing.jsx** — NEEDS USER DECISION: "Graph Queries" meter (540) uses the `searches` limit because no `graphQueries` quota exists in the PLANS data — what's the per-plan graph-query quota (or drop the meter)? Also: annual toggle is cosmetic (−20% label but checkout charges monthly) — wire `billingCycle` into `createBillingCheckout` or remove the toggle? Once decided: also replace alert()+console with inline errors (419-432) + numeric price in PLANS.
- [~] **WebIntelligence.jsx** — ✅ i18n `[object Object]` fixed (908, 24bcee5). REMAINING: align radii `rounded-xl`→`[10px]` + H1 recipe; surface silent save errors (248-313); a11y label/htmlFor on crawl inputs.

### Theme hard-rule violations (purple/violet/off-shell)
- [ ] **WebStudio.jsx** — scope SINGULANCE serif/Google-Fonts + 2nd accent (#1a45c4/violet) to the NEW-TAB report only; in-app `ResearchPreviewModal` must use theme tokens (no external `@import` into the live app, 112-164,989); re-map violet research/crawl accents → #117dff (768-1164); fix `LiveResearchPanel` auto-scroll no-op (757 — ref on non-scroller); whitelist `https?:` in `mdToHtml` link href (1603).
- [ ] **AgentSwarm.jsx** — remove violet/purple gradient + badges (29-31,691,930 `from-violet-500 to-purple-500`) → sanctioned blue/amber/emerald; alert()/confirm → in-page toast (flash) + one styled confirm for bulk-delete; `font-bold`→`font-semibold` (369,490); emoji→lucide icons; clear poll intervals before reassign (117-124).
- [ ] **TaraConfig.jsx** — recolor purple→#117dff + flatten glassmorphism skill-card tiles (107-546); delete ~270 lines of dead eslint-disabled components (ConfigEditor/LiveTest/ActiveSessions, 39-504); guard `startedAt` dates (772-853); surface silent load errors (765-768); H1 → `text-[24px] font-semibold`.
- [ ] **KnowledgeBase.jsx** — normalize radii (`rounded-2xl/xl`→`[10px]`, controls `[6px]`) + soften shadows; H1+section heads to design recipe + drop Space Grotesk on body; map `TYPE_COLORS.general` gray→warm neutrals, drop violet enterprise badge (227,1490,1847); a11y labels on bulk checkboxes + delete btn (1930-2069); remove console.log (2150).
- [~] **Profile.jsx** — ✅ avatar gradient+shadow → flat solid #117dff (135, 24bcee5). REMAINING: surface fact edit/delete errors + remove console.error (747,759); fix "Edit Profile Facts" collapsing the open editor (1256,1315).
- [~] **Engine.jsx** — ✅ renamed `t`-shadow map params (365,372 → 24bcee5). REMAINING: drive the "all features active" status bar from real state or label it a static legend (614-630, currently lies); inline error states instead of console.error-only (71-331); confirm step on destructive synthesize-now "Run now" (443).

### Polish / cleanup / smaller bugs
- [ ] **Connectors.jsx** — fix Nango-only scope-change dead path (803-820 gate `oauthProvider||nangoProvider` but onChangeScope wired only on oauthProvider → Settings save silently no-ops for Salesforce/Linear); alert()/confirm → themed toast/modal (esp. destructive Gmail flush 1146); env-source hardcoded URLs (360,2376,2910); remove console.* (1096-3760); off-token badges (436-446) → #117dff/amber-600; delete dead exports (StatsRow/CopyButton/CONNECTOR_CATEGORIES).
- [ ] **MemoryMoss.jsx** — wire `onSelectMemory` (MemoryGraph passes it 1418 but Moss ignores → leaf-node click does nothing); render or remove dead `subtitle`/`hubLeaves` props (224-235).
- [ ] **ApiKeys.jsx + McpServer.jsx** — drop off-shell `min-h-screen bg-… p-…` double-bg (ApiKeys 332, McpServer 1171); normalize radii to design system; wrap `handleRevoke` in try/catch (ApiKeys 324, floating promise); remove McpServer 200-line `display:none` dead Quick-Setup block (1305-1501).
- [ ] **Overview.jsx** — robust chat height (1056 drop magic `calc(100vh-104px)`); tone the oversized bold clock to match stat hierarchy (65); remove stray console.warn.
- [ ] **MemoryGraph.jsx** — remove the permanently-dead `{false && (...)}` temporal panel + its orphaned rAF/state (947-999, 1517-1664) OR re-enable it; remove eslint-disabled unused imports (14-21).

## Done (archive — newest first)
- [x] **Theme: all purple/violet removed** (AgentSwarm, TaraConfig, WebStudio, KnowledgeBase, Engine) → blue/#117dff single-accent. Da-vinci `d09c667`.
- [x] **Off-shell double-bg removed** (ApiKeys, McpServer, Memories) + ApiKeys revoke floating-promise guarded. Da-vinci `2f6446d`.
- [x] **Overview** clock weight (hierarchy) · **MemoryGraph** dead onSelectMemory prop + dead console handler · **KnowledgeBase** dead console handler. Da-vinci `ba21f9e`.
- [x] **MeetingNotes.jsx** — `MeetingIntelligencePanel` gated to the Summary tab (was rendering on Notes/Transcript too). Da-vinci `24bcee5`, CI build clean.
- [x] **HyperAgents.jsx** — malformed Tailwind `rounded-none-[24px]`/`-[20px]` → `rounded-none` (sharp, matches the 41 sibling popup classes). Da-vinci `85f4f98`, CI build clean.
<!-- the agent moves [x] goals here with their commit sha -->
