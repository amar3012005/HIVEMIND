# E2B Desktop canary

This is a separate, opt-in proof for E2B Desktop. It does not alter the local
Docker/CDP/noVNC canary and it is not connected to WorkRun.

## What it proves

1. An E2B Desktop sandbox can be created from the official `@e2b/desktop` SDK.
2. Chrome can be launched in that isolated desktop.
3. A local, non-submitting fixture can receive an agent keyboard action.
4. The desktop can provide an authenticated, interactive human stream.
5. A screenshot and a non-secret receipt are recorded locally.

The fixture has no network requests and no submit handler. The stream token is
never stored in the receipt or printed by default.

## Run

```sh
cd experiments/e2b-desktop-canary
npm install
E2B_API_KEY=... npm run canary
```

The command requires an E2B API key in the process environment. It keeps the
sandbox alive only when `E2B_KEEP_ALIVE=1`; otherwise it tears it down after
capturing evidence. Use `E2B_PRINT_STREAM_URL=1` only in a local terminal when
an operator is ready to open the authenticated interactive stream. Do not put
that URL in tickets, chat, or committed files.

## Evidence contract

The receipt contains sandbox identity, timing, screenshot path and hashes, and
whether the interactive stream was started. It deliberately excludes the stream
URL and its auth key. A live run is successful only after an operator verifies
the agent draft in the stream and makes a human edit before the sandbox is
released.
