# SINGULANCE Mac App — status, architecture, and the two account-level blockers

_Authored 2026-08-06. Covers `electron-app/` as shipped at **v2.1.0**. Written after a
recon pass that found most of what was asked for already built — the value here is
knowing what exists, what is verified, and what is genuinely blocked._

## The shape of the thing (why "add FE features to the app" is a no-op)

> **The desktop app is a window onto the live product, not a copy of it.**
> `main.js` loads `APP_URL` (`https://singulancelabs.com/hivemind/app/overview`, which
> 301s to `next.singulancelabs.com`). Verified 2026-08-06: both hosts serve the
> *identical* bundle `main.45e983a7.js`. So every frontend deploy reaches the app with
> no rebuild and no release.

Consequence: **there is no such thing as "the app is missing an FE feature."** If the web
app has it, the desktop app has it on next load. `build.files` even *excludes*
`react-build`, so the React build + copy steps in `release-mac.yml` are dead weight for
this architecture (skipped in the local 2.1.0 build with no effect on the bundle).

## What already existed before this session (verified live, not assumed)

| Capability | Where | Evidence |
|---|---|---|
| Remote-first delivery | `main.js` `APP_URL` | same bundle hash as browser |
| App auto-update + popup | `electron-updater`; `update-downloaded` → "Restart Now / Later" | `autoDownload=true`, `autoInstallOnAppQuit=true`, dock progress badge, tray + menu "Check for Updates…" |
| **Frontend** update popup | `main.js:145-187` | polls `/asset-manifest.json` every 10 min + on window focus → "HIVEMIND updated — Reload Now". Manifest fetch returns 200 JSON with `files['main.js']` |
| Download button | `Da-vinci .../cartesia/DownloadMacButton.jsx` | resolves newest release via GitHub API, sessionStorage cache, 8s timeout, real `<a href>` fallback |
| Signing/notarize wiring | `scripts/notarize.js`, `release-mac.yml`, `APPLE_SIGNING.md` | complete — and **no-ops** until secrets exist |

Nothing in that list needed building. Recon before building saved the duplicate.

## Added in 2.1.0 — the notch HUD

`src/notch.js` · `src/notch.html` · `src/notch-preload.js`, mounted from `app.whenReady()`.

Glass panel that drops from under the MacBook notch. Hover the pill to open, click to
pin, `Esc` to close.

- **Capture a thought** → durable memory via core `POST /api/ingest/source` (⌘↵ saves)
- **Knowledge base** → drop files anywhere on the panel (or pick). Uses the *same*
  control-plane path the web client uses: `POST /v1/proxy/knowledge/upload?async=true`
  → `job_id` → poll `/v1/proxy/knowledge/status`. Each file reports real job status.
- **AI meeting notes** → routes into the product's existing meetings flow.

### Two decisions that keep it robust

1. **No duplicated auth.** The panel is local (`file://`) so it paints instantly and is
   fully styleable, but **every API call executes inside the main window's page context**
   via `executeJavaScript`. That origin is already signed in, so the session cookie and
   stored `X-API-Key` apply exactly as in the web app. No CORS, no token copying, no
   second auth path to drift out of sync.
2. **No invented endpoints.** All three paths were read out of `api-client.js` first and
   reused verbatim, so scope, quota and dedup behave identically to an in-app action.

**Deliberately NOT built:** a second audio recorder in the notch. That would fork the
transcription pipeline for no gain — the notch is a fast way *in*, not a parallel
implementation.

Collapsed it is a 210×34 pill over the notch (dead screen area on notched Macs; a
floating pill under the menu bar otherwise). `alwaysOnTop('screen-saver')` +
`visibleOnFullScreen` so it survives a full-screen meeting; re-anchors on display
changes; destroyed on `before-quit` so it cannot outlive the app and strand a black pill
over the menu bar. Mount is `try/catch` — a HUD failure must never stop the app opening.

## Release state

| Item | Value |
|---|---|
| Version | **2.1.0** (was 2.0.3, Jul 5) |
| Commits | `d5a4596c` notch HUD · `964588da` version bump — on `singulance-main` |
| Tag / release | `v2.1.0`, published with DMG (167.8 MB universal), zip, blockmaps, `latest-mac.yml` |
| Built | **Locally**, not by CI (see blocker 1) |
| Verified in bundle | `notch.js`, `notch.html`, `notch-preload.js` present inside `app.asar` |
| Rollback | `gh release delete v2.1.0 --repo amar3012005/HIVEMIND --yes` → download reverts to 2.0.3 |

## Blocker 1 — GitHub Actions is billing-locked

`release-mac.yml` has never successfully built a tagged release since v2.0.2. Both v2.0.3
and v2.1.0 failed in ~4s with **zero steps executed**. GitHub's own check-run annotation:

> `The job was not started because your account is locked due to a billing issue.`

**The workflow and the build are fine** — the job never gets a runner. This is why v2.0.3's
DMG was built by hand, and why 2.1.0 was too.

Workaround (proven, used for 2.1.0) — release upload needs no Actions billing on a public repo:

```bash
cd electron-app
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder build --mac --universal --publish=never
gh release create vX.Y.Z dist/*.dmg dist/*.zip dist/*.blockmap dist/latest-mac.yml --repo amar3012005/HIVEMIND
```

Once billing is cleared: `gh run rerun 31074573377` and CI does it automatically.

## Blocker 2 — unsigned / un-notarized (the "contains malware" error)

macOS Sequoia reports an un-notarized app as **"contains malware"** (it replaced the older
"unidentified developer" wording). Root cause chain, all verified:

- `gh secret list` → **no** `APPLE_ID` / `MAC_CSC_LINK` / `APPLE_TEAM_ID` secrets exist
- `scripts/notarize.js:17` → skips with *"unsigned build"* when those are absent
- `hardenedRuntime: true` **without** a Developer ID signature is what Gatekeeper rejects hardest

Nothing regressed — **the app has never been signed**, from v1.0.0 onward.

Independent confirmation observed the same day: macOS `SIGKILL`ed and then **XProtect
deleted** the freshly downloaded unsigned Electron *dev* binary (`node_modules/electron/
dist/Electron.app`) twice on this machine. Same mechanism, same root cause.

User-side workaround (their own app, so legitimate):

```bash
xattr -dr com.apple.quarantine /Applications/SINGULANCE.app
```

Real fix: Apple Developer Program membership + Developer ID cert → add the 5 secrets in
`electron-app/APPLE_SIGNING.md`. The code is already wired; adding the secrets turns it on
with **no code change**. Also note Squirrel.Mac generally refuses *unsigned* update
bundles, so signing is what makes auto-update actually apply, not just advertise.

## Open / unverified — stated honestly

- **The notch HUD has not been run.** Syntax checked, element references verified,
  integration wired, files confirmed inside `app.asar` — but never rendered, because
  XProtect deletes the unsigned Electron dev binary on this machine. Needs a signed build
  (or a machine that will run it) to exercise. First real check: does the pill appear at
  the right geometry, and does it behave on a non-notch Mac and a multi-display setup.
- Notch geometry uses a fixed 210 px pill centred on the primary display rather than
  querying real notch metrics (Electron exposes none). Fine in principle; unproven.
- `release-mac.yml` still builds + copies the React app, which `build.files` excludes.
  Harmless, but ~2-5 min of wasted CI per release — worth deleting when CI runs again.

## Rules of thumb for the next session

1. **Do not "add FE features" to the app.** It is remote-first; the feature is already there.
2. A new version is only warranted for **shell** changes (`electron-app/`), not product changes.
3. Before tagging, verify the `frontend/Da-vinci` gitlink is a **pushed** commit —
   an unpushed gitlink kills the CI submodule step instantly.
4. CI cannot build until billing is cleared; use the local-build + `gh release create` path.
5. Until the Apple secrets exist, every build shows "contains malware" — ship the
   `xattr` line in the release notes.
