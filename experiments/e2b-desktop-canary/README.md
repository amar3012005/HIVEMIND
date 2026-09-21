# E2B Computer Runtime V1 canary

This is a separate, opt-in proof for E2B Desktop. It does not alter the local
Docker/CDP/noVNC canary and it is not connected to WorkRun.

## Scope

This is a separate, opt-in E2B implementation. It deliberately does not change
the Docker/CDP/noVNC proof and is not connected to WorkRun or AgentScope.

The pinned runtime is Node 22 LTS and `@e2b/desktop` `2.4.0` (see the committed
lockfile). The wrapper exposes only computer lifecycle and interaction methods;
there is no AgentScope dependency.

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
