# DSH mobile parity and native authentication design

Inspected 8 October 2026. DSH MCP `docs_search` and `docs_read(capability-seams.md,1–120)` describe connection, attachments, session persistence, Remotes and experimental capabilities. Snapshot reports `revision:null`; therefore these notes derive actual contracts from freshly fetched Harness `origin/singulance-main`, `28f65228d82049f4ce1b7269bbdb19e03b697885`. Documentation alone is not evidence that a plugin is mounted or exposed to a tenant.

## Actual mounted graph and mobile obligations

Composition: `packages/bundle/web-app/cordis.patch.yml` plus `packages/bundle/hivemind-web-app/cordis.patch.yml`; per-agent registrations belong to `packages/preset/agent-presets/presets/{hivemind-chat,hivemind-hyperagents,hivemind-hq}/agent.cordis.yml`. Parent production overlays and environment remain additional authorities. Package presence does not prove deployed enablement.

| Feature | Actual source owner | Mobile parity / proof still required |
|---|---|---|
| Persistent sessions, recent runs, older history and date rail | `packages/api/session-controller/src/history.ts`, `cold-history.ts`; web rows `session-controller`, `session-turn-outline`, `ui-session`, `ui-chat` | Use native bounded backward page and durable cursor/follow. Latest view must not fetch years of events. Check reconnect catches suffix once, prepend preserves viewport, date jump loads target and tenant-denied reads stay denied. |
| Streaming replies, tool cards and progress | `packages/client/connection/src/client/rpc.ts`, `ui-conversation`, `ui-tool`, `ui-chat` | Preserve native stream and grouping; narrow card overflow belongs inside card. Neither a whole-page scrollbar nor suppressed final answer is acceptable. |
| Approvals and user questions | Web rows `ui-approval`, `ui-user-questions`; Runtime `question-recovery-host.ts` | Keyboard/screen-reader usable request, durable answer receipt, expired/rejected handling, foreground/background delivery. Native notification tap must never imply approval. |
| Skills, reference picker and model selection | Web `ui-skill`, `ui-reference`, `ui-input-trigger`, `ui-model-selection`; `packages/hivemind/progressive-skills` | Compact composer access without hiding capability. Existing allowed preset/model/skill catalog remains authoritative. |
| Teams, task boards and employee identity | HIVE rows `agent-team`, `tool-agent-team`, `ui-agent-team`, `ui-hivemind-hq`; `packages/hivemind/employee-{directory,delegation}` | Reuse persistent employee rooms; scheduled/completed/banner state and approval indicators remain visible at phone widths. Experimental team package is explicitly configured for OS roots, not universally authorized. |
| Attachments and reference images | Web `file-upload`, `ui-attachment`; DSH attachment/file reference services | System picker, upload progress/retry, allowed MIME/size and tenant addressing. Supplied pixels must remain actual image input when selected provider supports it. No broad photo permission merely to pick one file. |
| HTML/image/PDF preview and download | Web `ui-sidebar-documentpreview`, `ui-deliverables`, `ui-sidebar-right`; `packages/hivemind/artifact-renderer` | Full-screen mobile preview, safe areas, document-local pan/zoom, device download/share. Untrusted HTML must not access Capacitor bridge or session tokens. |
| Voice / dictation | `packages/client/ui-workspace/src/client/grok-voice.ts`; FE `HarnessSurface.jsx` transcription hook | Microphone consent, provider consent, actual recording/call Stop, interrupted call, transcript returns to correct room. Web API availability on a desktop browser does not establish WKWebView/Android WebView behavior. |
| Feedback / safety reporting | Web `message-feedback`, `ui-message-feedback` | Native feedback exists; demonstrate separate actionable content-safety report through in-app submission and developer handling. A thumbs-down dialog alone does not establish Play safety compliance. |
| Recovery and scheduled work | `packages/hivemind/hq-runtime/src/service-recovery.ts`; HIVE ownership/persistence/schedule | Server recovers only eligible interrupted work from receipts, not user Stop or approval pending. Device suspend should reconnect, never fabricate a new awakening or duplicate external action. |
| Memory and connected apps | `packages/hivemind/{memory,connected-apps,context,execution-scope}`; FE Core API | Same tenant scope, explicit connector authorization/AI consent, staged context and revocation. OAuth is external system browser with verified return. |
| Jobs, plans, goals and workflows | Web `ui-jobs`, `ui-plan`, `ui-goal`, `ui-workflow-run`, `ui-hivemind-operating-run` | Existing authorized catalogs on demand; compact phone presentation rather than removing capabilities. Server background work does not require an unrestricted native background service. |
| Schedule catalog | Web `ui-schedule` is disabled by default; host HIVE scheduling remains configured separately | Verify final overlay rather than toggling all plugins. Existing company scheduling UI can render actual server assignments. |
| Desktop workspace, directory picker, terminal and open-in-app | Web graph contains directory picker, workspace surfaces and open-in-app; HIVE disables ordinary workspace and uses virtual workspace | These refer to host/server filesystem, not phone filesystem. Do not expose unrestricted terminal/host credentials to tenants or imply users can browse device data through server tool-fs. |
| Experimental browser/computer-use providers, worker-host transport | MCP graph names experimental providers; not proof of mounted HIVE capability | Treat as separately authorized integrations. Their existence does not mean on-device phone automation or remote computer control should be enabled for mobile. |

“Every DSH feature” means preserve the product’s configured, authorized feature graph and mobile access to it. It does not mean every package installed in the monorepo, unrestricted host control, or expanded tenant permissions.

## Authentication seam: why local packaging alone is incomplete

Baseline hosted Capacitor URL uses `https://next.singulancelabs.com/hivemind/m/chat`. Current native preparation removes remote loading by default and packages FE, creating Android `https://localhost` and iOS `capacitor://localhost` origins. This changes an existing security boundary, not just asset delivery.

- Core `core/src/control-plane-server.js:getCurrentSession` accepts signed `hm_cp_session` cookie or Bearer containing a CP session identifier; it then resolves the real server session. A Core API key is **not** that CP session identifier.
- Existing `/auth/cli/start` is loopback/Chromium-extension only. Its one-use exchange yields an API key, so widening its callback list is not a complete native session bootstrap.
- FE `src/components/hivemind/app/pages/HarnessSurface.jsx` first gets `/v1/harness-chat/bootstrap` admission through authenticated CP Axios. It then POSTs the ticket to same-origin `/api/hivemind/session/establish` with cookies, reads `/api/hivemind/boot`, imports `/assets/harness-shell.js`, and supplies a same-origin transcription hook.
- FE Worker `cloudflare/worker.mjs` forwards `/api/*`, `/plugins/*` and native assets to Runner, preserves actual browser Origin, and adds the admission cookie after successful establishment.
- Harness `packages/hivemind/web-runner/src/index.ts` validates configured `parentOrigins` **and same public authority** for exchange; boot and tenant authorization resolve authenticated Runner cookie. CP Bearer does not automatically authenticate Runner.
- `packages/client/connection/src/client/rpc.ts` resolves RPC endpoints against page `location.origin`. `__DSH_TRANSPORT__` supports owner-supplied fetch/openStream/loadBundle, but `ownsHost:true` declares the page owns Host and bypasses a privilege surface. **Never set it for hosted mobile.**

## Smallest safe implementation choices

### A. Hosted HTTPS application, native one-use auth grant

This retains the existing mounted native graph and cookie authority while the native shell handles browser login, permissions and device controls. It is the least transport change; store minimum-functionality evaluation still concerns the whole experience, not whether assets are remote.

1. App creates high-entropy verifier/state and PKCE S256 challenge; keeps verifier outside URLs. Begin a dedicated mobile-auth intent with exact registered callback, challenge, expiry and approved app target.
2. System browser performs existing authentication. Server validates intent/session and redirects only a short-lived one-use code plus bound state to the registered app callback. Never redirect raw session/API token.
3. Native validates callback path/state; its trusted HTTPS WebView POSTs code+verifier to a same-origin exchange. Server atomically consumes intent, creates/retrieves scoped CP session and sets HttpOnly Secure cookie. Confirm whether selected native browser/network API shares WebView cookie store; system-browser cookies must not be assumed to transfer.
4. Hosted FE resumes ordinary CP bootstrap → Runner ticket → cookie → boot/RPC/stream. Preserve Runner origin fences and tenant/membership checks.
5. Logout/revocation clears actual CP/Runner sessions and native grant material. Reload/return must remain stable.

### B. Packaged frontend with explicit authenticated transport

If packaged assets are required, implementation must cover **all** CP and Harness paths; merely adding localhost to CORS or Axios Authorization is insufficient.

1. Use the same server-bound PKCE one-use flow to obtain a revocable short-lived native session grant. Store it in OS-protected storage; avoid frontend localStorage and URL tokens. Grant authorizes the signed-in user, never browser-selected org alone.
2. Either add a narrowly authenticated HTTPS transport endpoint that preserves native RPC envelopes plus streaming and asset authorization, or run a trusted hosted bridge document that owns HttpOnly cookies and proxies typed requests/streams over a strictly validated message channel. Bridge requires exact origin/source, nonce, bounded messages, allowed methods/routes and request correlation; never generic URL forwarding.
3. Feed real `fetch/openStream/loadBundle` hooks before mounting native modules. HTTP modules/CSS/assets, file upload/download, boot, speech, cookie expiry, event streams and recovery all require coordinated ownership. Remote dynamic import must be CORS/CSP authorized without exposing private boot graph to arbitrary origins.
4. If using HTTP streaming instead of WebSocket, preserve native ordered cursors/cancellation/reconnect semantics. If WebSocket, use a bounded handshake grant; browsers cannot add arbitrary Authorization headers to WebSocket constructors. No long-lived token in URL.
5. Untrusted artifact preview must live outside privileged bridge origin. Native code should not grant arbitrary remote pages app plugins. Restrict navigation and callback host/path at native layer.

No supplied source currently proves B end to end. It is a release blocker until app installs demonstrate it; A and B must not be silently mixed.

## Required focused verification

- Auth: success, cancelled login, expired/replayed code, wrong verifier/state/callback, attacker redirect, missing membership, revoked session, cross-user/org denial, logout/relogin.
- Cookies: actual iOS/Android WebView establishes CP and Runner sessions, not merely browser/CLI tests; private boot/asset/gateway denied without principal.
- Native transport: full boot with styles/modules, stream reply, tool result, approval, attachment upload, private preview/download, voice transcript and older-history page. Repeat after app suspension, network loss, token expiry and server restart.
- Safety: deliberate Stop/paused autonomy/awaiting approval do not resume; unknown tool outcomes reconciled before repeat; multiple reconnects do not create duplicate messages/writes.
- Device layout: narrow phone, safe areas, native keyboard and large accessibility text; controls remain reachable with visible primary Send/Stop and secondary voice.

These are verification targets, not assertions of completed checks. Attach immutable binary hashes and device results to READINESS.md when implemented.
