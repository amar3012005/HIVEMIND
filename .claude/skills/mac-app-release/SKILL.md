---
name: mac-app-release
description: Build, sign, notarize, release, and verify the HIVEMIND macOS desktop app and its auto-update feed. Use whenever the user wants to cut a Mac release, bump the desktop version, ship a desktop update, debug auto-update ("update not installing", "damaged app", "Gatekeeper"), fix the Download-for-Mac button, or change which server the desktop app points at. Triggers: "build the mac app", "release the desktop app", "cut a mac release", "ship a desktop update", "mac auto-update broken", "notarize", "sign the app", "new dmg", "bump app version".
---

# HIVEMIND macOS app — release & auto-update

Electron wrapper of the Da-vinci React build, with electron-updater auto-update
served from GitHub Releases (latest-mac.yml feed). This skill owns building,
releasing, and keeping updates robust.

## Topology
- App: electron-app/ — src/main.js (window, tray, updater, hivemind:// protocol),
  src/preload.js (bridges: onUpdateStatus, onDeepLink, checkForUpdates, installUpdate),
  scripts/notarize.js (afterSign hook, no-op without Apple creds).
- In-app update UI: frontend/Da-vinci/src/components/hivemind/UpdateBanner.jsx (mounted in App.js).
- Renderer build: electron-app build:react bakes REACT_APP_CONTROL_PLANE_URL=https://api.singulancelabs.com
  + REACT_APP_CORE_API_URL=https://core.singulancelabs.com (this is why the desktop app talks to the singulance self-host).
- Release CI: .github/workflows/release-mac.yml — on a v* tag: build universal → sign (if MAC_CSC_LINK secret)
  → notarize+staple (if APPLE_* secrets) → electron-builder --publish always → uploads dmg/zip/latest-mac.yml.
- Download button: frontend/Da-vinci/src/components/hivemind/cartesia/DownloadMacButton.jsx (cached GitHub API resolve, never-dead).
- Repo: amar3012005/HIVEMIND. Universal .dmg (arm64+Intel), no arch split.

## Golden rule
Auto-update only works if the build is signed + notarized. Squirrel.Mac rejects unsigned update
bundles. A real release REQUIRES the 5 Apple secrets (see electron-app/APPLE_SIGNING.md).
Unsigned builds are dev/test only.

## Cut a release
    cd electron-app
    npm version patch          # 1.0.3 -> 1.0.4
    cd .. && git add -A && git commit -m "release: desktop v$(node -p "require('./electron-app/package.json').version")"
    V="v$(node -p "require('./electron-app/package.json').version")"
    git tag "$V" && git push origin HEAD && git push origin "$V"
CI builds + (if secrets) signs/notarizes + publishes. Release must contain:
*-universal.dmg, *-universal-mac.zip (update payload), latest-mac.yml (feed).

## Pre-release gate (before tagging)
    cd frontend/Da-vinci && CI=true npm run build | tail -2          # warnings=errors
    cd ../../electron-app && node -c src/main.js && node -c src/preload.js && node -c scripts/notarize.js
    node -p "require('./package.json').version"

## Verify a shipped release
    curl -s https://api.github.com/repos/amar3012005/HIVEMIND/releases/latest \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['tag_name']);[print(' ',a['name']) for a in d['assets']]"
    # must list *-universal.dmg, *-universal-mac.zip, latest-mac.yml
    # on an installed Mac:
    spctl -a -vvv -t install /Applications/HIVEMIND.app   # want: source=Notarized Developer ID

## Debug
- "damaged / can't be opened" -> unsigned build -> add 5 Apple secrets, re-tag.
- Auto-update never installs -> unsigned, or latest-mac.yml missing -> sign+notarize; ensure --publish always uploaded the yml.
- App hits old server (davinciai) -> renderer built without REACT_APP_* -> rebuild via build:react (envs baked) or set in CI.
- Update errors invisible -> ~/Library/Logs/HIVEMIND/main.log (electron-log).
- Download button opens releases page -> GitHub API rate-limited (expected fallback; cached, works next load).
- "No identity found" in CI -> MAC_CSC_LINK absent => unsigned by design; add it to sign.

## Update mechanics
autoDownload=true + autoInstallOnAppQuit=true: silent background download; download-progress streams to
UpdateBanner (% + dock badge); on update-downloaded -> Restart-now or install on next quit. Manual
"Check for Updates" (tray/menu + window.electron.checkForUpdates()) gives explicit feedback. All updater
events logged via electron-log.

## Do / Don't
- DO bump electron-app/package.json version every release (tag must match).
- DO keep the universal target. DO run the pre-release gate.
- DON'T ship unsigned as a real release (can't auto-update).
- DON'T hardcode server URLs in renderer (use baked REACT_APP_*).
- DON'T add a second GitHub-release step (electron-builder --publish always owns it).
