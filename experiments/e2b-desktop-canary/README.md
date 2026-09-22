# E2B Computer Runtime V1 canary

This is a separate, opt-in proof for E2B Desktop. It does not alter the local
Docker/CDP/noVNC canary and it is not connected to WorkRun.

## DOM-first Computer Operator baseline

`src/operator/` is the standalone execution core for the next canary. It has
no AgentScope dependency and receives one bounded job, compiles it to a browser
plan, then operates through an injected driver. The driver can be Playwright
over CDP in a custom E2B template, while E2B Desktop's authenticated stream
remains only the human-view/takeover channel.

The core is intentionally site-agnostic: it has no X, Spotify, company, or
credential-specific code. It chooses actions in this order:

1. exact DOM target supplied by the bounded plan;
2. unambiguous local candidate rules;
3. optional typed decision engine (Jev or a local compatible runtime);
4. optional visual fallback;
5. pause for a human when confidence or authority is insufficient.

It enforces a step/time budget and stops after repeated browser states instead
of retrying a click loop. The offline test uses a mock public-profile fixture:
one natural-language objective becomes a bounded plan, selects the `Followers`
candidate through DOM metadata, and returns a structured count receipt without
calling a model.

`PlaywrightDriver` connects to an existing Chromium CDP endpoint. That endpoint
must be reachable *inside the E2B microVM* so DOM inspection, selection, and
clicks stay local. The current E2B Desktop template is retained as the visible
handoff proof; the next live acceptance must use a custom E2B template with
Chromium, `playwright-core`, the worker, and a local fixture preinstalled.

### Live DOM template canary

The committed `template/worker/` package and `build:dom-template` command make
that custom image. It inherits E2B's `desktop` template rather than recreating
its graphical environment, then installs and verifies Node 22, `playwright-core`, the generic
operator, and the network-free fixture worker. The build uses 2 vCPU and 4 GB
RAM only for this canary; it is not a production capacity declaration.

```sh
E2B_API_KEY=... npm run build:dom-template
E2B_API_KEY=... npm run dom-canary
```

The DOM canary starts the visible Chrome as an E2B-managed background process
with loopback CDP, runs the worker *inside the same microVM*, and captures a
secret-free receipt and screenshot. It intentionally disables internet access
and only uses a fixture written into that sandbox. The first live success is
therefore proof of local DOM candidate selection and execution, not proof of
an authenticated social-media workflow.

## Scope

This is a separate, opt-in E2B implementation. It deliberately does not change
the Docker/CDP/noVNC proof and is not connected to WorkRun or AgentScope.

The pinned runtime is Node 22 LTS and `@e2b/desktop` `2.4.0` (see the committed
lockfile). Each canary explicitly requests a 15-minute E2B lease; it does not
rely on E2B's short default sandbox timeout. The wrapper exposes only computer
lifecycle and interaction methods; there is no AgentScope dependency.

## Runtime V1 acceptance contract

The offline suite exercises the supervisor contract with deterministic E2B
Desktop doubles:

| Capability | Contract |
| --- | --- |
| Agent + human | Same sandbox and Chrome session retain the human-edited draft. |
| Human ownership | Agent mutations fail with `computer_locked_by_human`. |
| Controller recovery | A new controller reconnects from the durable lease. |
| Pause/resume | A full-memory pause reconnects to the same draft state. |
| Isolation | Three computers have independent browser and filesystem state. |
| Capacity | A fourth lease waits until an active lease is released. |
| Receipts | Every mutation is durable and redacts credentials, tokens, OTPs, and cookies. |
| Browser recovery | Chrome gets exactly one in-place recovery attempt. |
| Controller crash | An uncompleted receipt becomes `unknown_outcome`; it is never replayed. |
| Network profile | `computer:safe-local` expects external network access to fail. |

The network-free fixture has no submission handler; its button is disabled.
Draft state is reflected in the page title, allowing a controller to observe the
same running browser without a custom CDP or VNC control path.

The stream token and URL are never stored in receipts or printed. A caller may
open the returned URL directly in the local operator's browser, but it remains
process-local.

## Run

```sh
cd experiments/e2b-desktop-canary
npm install
E2B_API_KEY=... npm run canary
```

The command requires an E2B API key in the process environment. It keeps the
sandbox alive only when `E2B_KEEP_ALIVE=1`; otherwise it tears it down after
capturing evidence. `E2B_OPEN_STREAM=1` opens the authenticated stream locally
without printing its URL. Do not put that URL in tickets, chat, or committed
files.

Run the V1 offline contract suite:

```sh
npm test
```

After rotating the exposed E2B credential, run the manual, live same-computer
handoff. It opens an authenticated stream locally, pauses after the human edit,
and prints only the secret-free lease path:

```sh
E2B_API_KEY=... npm run v1
# In a new terminal after the first process pauses:
E2B_API_KEY=... npm run resume -- /absolute/path/to/lease.json
```

If the macOS default browser is not the browser the operator is using, start a
one-use loopback redirect. It prints only a local URL; the E2B stream URL and
auth key remain in memory and are discarded after the first redirect:

```sh
E2B_API_KEY=... npm run open-stream -- /absolute/path/to/lease.json
```

The `resume` command reconnects through `Sandbox.connect()`, checks the same
browser's title and screenshot, then kills the sandbox. The live suite must
also be extended with a three-sandbox actual E2B isolation run and a normal
internet `computer:web` run before AgentScope integration.

## Evidence contract

The receipt contains sandbox identity, timing, action metadata, page title, and
screenshot path/hashes. It deliberately excludes typed secrets, stream URL,
auth key, passwords, cookies, and OTPs. A live run is successful only after an
operator verifies the agent draft in the stream, makes a human edit, and the
separate controller observes it before the sandbox is released.
