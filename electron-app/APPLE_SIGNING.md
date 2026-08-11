# Apple Code Signing + Notarization — the 5 secrets

This is the ONE manual step that makes the Mac app install cleanly (no "damaged"
Gatekeeper warning) and makes **auto-update actually work** (Squirrel.Mac refuses
unsigned update bundles). The code (afterSign hook + CI) is already wired and
no-ops until these exist — so nothing breaks before you do this; it just turns on.

## 0. Prerequisite
Apple Developer Program membership — $99/yr — https://developer.apple.com/programs/
(Individual or Organization. Org gives a company team name on the cert.)

## 1. Create the "Developer ID Application" certificate
1. Xcode → Settings → Accounts → add your Apple ID → **Manage Certificates** → **+** → **Developer ID Application**.
   (Or developer.apple.com → Certificates → **+** → "Developer ID Application" → upload a CSR from Keychain Access → Certificate Assistant → "Request a Certificate from a CA".)
2. It lands in **Keychain Access → login → My Certificates** as
   `Developer ID Application: <Your Name/Org> (TEAMID)`.

## 2. Export it as a .p12
1. Keychain Access → My Certificates → right-click the **Developer ID Application** cert (expand it so the private key is included) → **Export** → format **Personal Information Exchange (.p12)**.
2. Set a strong password — this is `MAC_CSC_KEY_PASSWORD`.
3. Save as `developer-id.p12`.

## 3. Base64-encode the .p12 (for the GitHub secret)
```bash
base64 -i developer-id.p12 | pbcopy   # now on your clipboard
# (or: base64 -i developer-id.p12 -o developer-id.p12.b64)
```
That base64 string is `MAC_CSC_LINK`.

## 4. App-specific password for notarization
1. https://account.apple.com → Sign-In & Security → **App-Specific Passwords** → **+** → name it "hivemind-notarize".
2. Copy the generated `xxxx-xxxx-xxxx-xxxx` → this is `APPLE_APP_SPECIFIC_PASSWORD`.

## 5. Find your Team ID
https://developer.apple.com/account → Membership → **Team ID** (10 chars, e.g. `AB12CD34EF`) → `APPLE_TEAM_ID`.
Your Apple ID email → `APPLE_ID`.

## 6. Add the 5 GitHub secrets
Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|--------|-------|
| `MAC_CSC_LINK` | base64 of `developer-id.p12` (step 3) |
| `MAC_CSC_KEY_PASSWORD` | the .p12 password (step 2) |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | step 4 |
| `APPLE_TEAM_ID` | step 5 |

## 7. Cut a signed, notarized, auto-updating release
```bash
cd electron-app && npm version patch    # bumps package.json (e.g. 1.0.3 → 1.0.4)
git commit -am "release: v1.0.4" && git tag v1.0.4 && git push && git push --tags
```
The `release-mac.yml` workflow then: builds the universal app → **signs** (Developer ID)
→ **notarizes + staples** (afterSign hook) → `electron-builder --publish always`
uploads `HIVEMIND-1.0.4-universal.dmg/.zip` + **`latest-mac.yml`** (the update feed)
to the GitHub release. Existing installs auto-update on next launch/quit.

## Verify it's signed (after download)
```bash
spctl -a -vvv -t install /Applications/HIVEMIND.app   # → "accepted, source=Notarized Developer ID"
codesign -dv --verbose=4 /Applications/HIVEMIND.app   # shows the Developer ID authority
```

## Local signed build (optional, needs cert in your login keychain)
```bash
cd electron-app
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
npm run dist      # CSC auto-discovered from keychain; afterSign notarizes
```

Without these secrets the build still runs — just unsigned (Gatekeeper warning +
no auto-update). With them, everything is robust.
