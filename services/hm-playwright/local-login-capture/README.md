# Social login capture — run on YOUR machine, not the server

`hm-playwright` runs headless on the box with no display, so there's nowhere
to type a password into it. This script fixes that the right way: you log in
on your own machine, in a real visible browser, and export the resulting
session (cookies + localStorage) to a file. The server then reuses that
session for read-only crawl/screenshot calls — it never sees your credentials.

**Scope, deliberately narrow:** this is for looking at pages that would
otherwise show a login wall (LinkedIn/X/Instagram profile pages, your own
feed) — not for scripting posts, follows, likes, or DMs. Reusing a session you
already created to read content is a different thing from automating actions
on your account; this only does the former.

## Setup (once, on your own machine)
```
cd services/hm-playwright/local-login-capture
npm init -y && npm install playwright
npx playwright install chromium
```

## Capture a session
```
node social-login-capture.mjs x
node social-login-capture.mjs instagram
node social-login-capture.mjs linkedin
```
A real Chromium window opens to that platform's login page. Log in exactly as
you normally would (2FA, CAPTCHA, all of it — the script never touches your
password). Once you're in, press Enter in the terminal. It saves
`out/<platform>.json` and closes the browser.

## Ship it to the server
That file is as sensitive as a password — it grants read access to your
account until it expires or you log out elsewhere.

Sessions are scoped **per org**, not global — without this, a different
tenant requesting `session:"linkedin"` would silently ride as *your*
authenticated identity. Find your org's UUID (`orgId` — same value used
everywhere else in HIVEMIND) and upload into that org's own subdirectory:
```
ssh <ssh-alias> mkdir -p /root/hivemind/services/hm-playwright/sessions/<your-org-id>
scp out/x.json <ssh-alias>:/root/hivemind/services/hm-playwright/sessions/<your-org-id>/x.json
```
Then delete your local copy once you've confirmed it landed. `sessions/` on
the server is gitignored and mounted read-only into `hm-playwright` — these
files must never reach a commit. A crawl must now pass both `session` AND
`org_id` to use one; a crawl that requests a session without a matching
`org_id` returns `400 org_id_required_for_session`, and one for a session
that doesn't exist under that org returns `409 session_not_found` — it never
silently falls back to anonymous, and it never falls back to another org's
session.

## When it stops working
Sessions expire, and some platforms (Instagram especially) tie sessions to
device/IP fingerprint — a session captured on your laptop and used from the
server's IP may get invalidated faster than one used consistently from one
place. If a crawl against a "session" platform starts coming back as a login
page instead of real content, just re-run the capture script for that
platform and re-upload.
