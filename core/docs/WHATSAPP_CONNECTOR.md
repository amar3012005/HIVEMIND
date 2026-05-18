# WhatsApp Connector

## Status

The current WhatsApp connector is implemented as a QR-paired WhatsApp Web integration.

It is not a Meta WhatsApp Cloud API integration.
It is not the older Hermes / Flask design documented elsewhere.

Current stack:

- Frontend connector tile and QR modal in `frontend/Da-vinci`
- Control-plane routes in `core/src/control-plane-server.js`
- Runtime session manager in `core/src/connectors/providers/whatsapp/manager.js`
- WhatsApp Web bridge in `core/src/connectors/providers/whatsapp/bridge.js`
- Browser runtime via `whatsapp-web.js` + Puppeteer/Chromium

## User Flow

1. User opens the WhatsApp connector in the Connectors page.
2. Frontend calls `POST /v1/connectors/whatsapp/qr`.
3. Control plane starts or resumes a WhatsApp Web session for that user.
4. Backend returns either:
   - `qr`
   - `paired: true`
   - `status: "generating"`
5. Frontend renders the QR and polls `GET /v1/connectors/whatsapp/status`.
6. User scans the QR from WhatsApp on their phone.
7. Backend session becomes ready.
8. Incoming WhatsApp messages are routed into HIVEMIND chat logic.
9. Replies are sent back through the paired WhatsApp session.

## Operating Modes

Hermes makes an important distinction that also applies here.

### Separate bot number

This is the recommended production mode.

Behavior:

- the paired WhatsApp account is a dedicated bot identity
- other people message that number directly
- HIVEMIND replies as that number

Advantages:

- clean user experience
- no ambiguity about who is talking
- lower operational confusion

Requirement:

- separate phone number with WhatsApp enabled

### Personal number / self-chat

This is the fastest testing mode.

Behavior:

- the user pairs their own WhatsApp account
- they open "Message yourself"
- they send messages to themselves
- HIVEMIND replies into that same self-chat thread

Advantages:

- very fast to test
- no extra number required

Tradeoff:

- less intuitive than a dedicated bot identity

## Hermes Comparison

Hermes exposes these two modes explicitly during setup:

- dedicated bot number
- personal self-chat

The current HIVEMIND connector already supports the underlying paired-session model, but it does not yet expose an explicit first-class mode selector in the same style.

Today, the effective behavior is:

- if a user pairs a dedicated WhatsApp number, HIVEMIND behaves like a bot account
- if a user pairs their personal WhatsApp account, they can use self-chat as a testing workflow

If full Hermes parity is desired, the next feature is an explicit setup choice in the WhatsApp connector UI:

- `Separate bot number`
- `Personal number (self-chat)`

That mode can then control guardrails such as:

- allowed inbound chat IDs
- whether non-self inbound messages are ignored in personal mode
- reply prefixing or identity hints
- onboarding copy after pairing

## API Routes

These routes are handled by the control plane:

- `POST /v1/connectors/whatsapp/qr`
- `GET /v1/connectors/whatsapp/status`
- `POST /v1/connectors/whatsapp/disconnect`

Legacy `/api/connectors/whatsapp/*` routes may still exist in code for compatibility, but the frontend should use `/v1/...`.

## Runtime Architecture

### Control plane

The control plane owns the user-facing connector lifecycle:

- authenticates the user session
- starts pairing
- reports pairing status
- disconnects sessions
- forwards inbound chat to HIVEMIND

The relevant wiring lives in `control-plane-server.js`:

- `waitForWhatsAppHandshake(...)`
- `buildWhatsAppConnectorStatus(...)`
- `whatsappManager.startPairing(...)`
- `whatsappManager.getStatus(...)`
- `whatsappManager.disconnect(...)`

### Lifecycle manager

`WhatsAppLifecycleManager` is the per-user session owner.

Responsibilities:

- create one bridge per user
- persist sessions to disk
- keep a short rolling per-chat history
- receive inbound messages from the bridge
- call HIVEMIND chat as the user
- send the reply back to WhatsApp

Important behavior:

- one paired user maps to one WhatsApp Web session
- session state is stored on disk, not in browser local state
- inbound messages are passed to `callCoreChatAsUser(...)`

### Bridge

`WhatsAppBridge` wraps `whatsapp-web.js`.

Responsibilities:

- launch the Puppeteer/Chromium client
- emit QR events
- emit ready/auth/disconnect/error events
- normalize inbound WhatsApp messages
- send outbound replies

The bridge uses `LocalAuth` for session persistence.

## Message Flow

Once a session is paired, the conversation path is:

1. user sends a WhatsApp message
2. `whatsapp-web.js` receives it
3. `WhatsAppBridge` emits `message`
4. `WhatsAppLifecycleManager` appends history
5. control plane calls `callCoreChatAsUser(...)`
6. core chat returns a response
7. manager sends the reply through `bridge.sendMessage(...)`
8. response appears in WhatsApp

This is the path that makes WhatsApp behave like `Talk to HIVE`.

## Infrastructure Requirements

This connector will not work reliably unless the server can run a real headless browser.

Minimum requirements:

- Chromium installed
- Puppeteer-compatible executable path
- writable persistent session directory
- enough memory for one or more browser processes
- long-running process supervision

Recommended environment variables:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
HIVEMIND_WHATSAPP_SESSIONS_DIR=/opt/hivemind-data/whatsapp-sessions
```

Runtime validation command:

```bash
npm run check:whatsapp-runtime
```

Recommended filesystem behavior:

- session directory must survive process restarts
- do not use ephemeral container storage for production sessions

## VPS vs Dedicated Worker

### Same server

You can run the connector directly in the control-plane process on a VPS if:

- usage is low to moderate
- this is still beta
- one failed browser session is acceptable operationally

This is the simplest deployment model.

### Dedicated worker

For production, a separate WhatsApp worker is better.

Recommended split:

- frontend
- control plane API
- dedicated WhatsApp worker service
- persistent volume for WhatsApp sessions

Reasons:

- Chromium crashes do not affect the main API
- browser dependencies stay isolated
- scaling is easier
- observability is cleaner

## Known Constraints

This connector uses an unofficial WhatsApp Web path.

That means:

- sessions can expire
- WhatsApp may rate-limit or invalidate automation patterns
- outbound behavior must remain conservative
- this is not the right primary channel for large-scale enterprise delivery

For serious production messaging, Meta WhatsApp Cloud API is the safer long-term route.

## Troubleshooting

### QR never appears

Likely causes:

- Chromium is missing
- `PUPPETEER_EXECUTABLE_PATH` is wrong
- required system libraries are missing
- session directory is not writable
- process cannot launch headless browser

What to check:

- control-plane logs
- startup errors from `WhatsAppBridge`
- filesystem permissions for the session directory

### QR appears but pairing never completes

Likely causes:

- QR expired before scan
- WhatsApp Web auth failed
- browser session disconnected after QR generation

What to check:

- `authenticated`
- `ready`
- `auth_failure`
- `disconnected`

### Pairing succeeds but chat does not reply

Likely causes:

- inbound message handler failed
- `callCoreChatAsUser(...)` failed
- reply send failed
- control plane lost session state

What to check:

- control-plane logs around `onInboundMessage`
- core `/api/chat` availability
- outbound `sendMessage(...)` errors

## Frontend Notes

Frontend implementation currently lives in:

- `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/pages/WhatsAppQRModal.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`

The frontend should:

- use `/v1/connectors/whatsapp/*`
- keep retrying when QR status is `generating`
- poll status until paired or timeout

## Recommendation

Short term:

- keep the current QR-paired connector
- use a dedicated WhatsApp number for bot use
- run it on a VPS with persistent session storage

## VPS Hardening Checklist

Use this sequence on the server that runs the control plane:

1. Install Chromium and the required system libraries.
2. Set `PUPPETEER_EXECUTABLE_PATH`.
3. Set `HIVEMIND_WHATSAPP_SESSIONS_DIR` to a persistent writable path.
4. Run `npm run check:whatsapp-runtime`.
5. Restart the control-plane service.
6. Perform one real QR scan and watch control-plane logs during pairing.

Example Debian or Ubuntu package install:

```bash
apt-get update
apt-get install -y chromium
```

Example environment:

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
export HIVEMIND_WHATSAPP_SESSIONS_DIR=/opt/hivemind-data/whatsapp-sessions
```

Example validation and launch:

```bash
npm run check:whatsapp-runtime
npm run control-plane
```

During the first real pairing test, inspect logs for:

- QR generation
- `authenticated`
- `ready`
- `auth_failure`
- `disconnected`

Long term:

- move browser runtime into a dedicated worker
- keep control plane as orchestration only
- evaluate Meta WhatsApp Cloud API for production-scale messaging
