# BYOD HyperAgent Harness (native DeepSeek web)

One Harness process, **native UI**, every shipped mode (chat, HyperAgents,
standard, ptc, cordis, minimal, hivemind). Pick mode and models in the UI.
Not Da-vinci. Not k3.

```text
Browser → native Harness UI
  → Connect to HIVEMIND
  → select mode + model
  → cwd = data/fs/org/<orgId>/users/<userId>/workspace
```

Filesystem (same sandbox, isolated per invited user):

```text
data/fs/org/<orgId>/
  shared/                      org-wide
  users/_owner/workspace       first user (whole org sandbox)
  users/<userId>/workspace     each additional invited user
```

Set `HIVEMIND_USER_ID` for the owner and `HIVEMIND_INVITED_USER_IDS` (comma
UUIDs) when more people are invited. `ensure-org-fs.mjs` creates the trees
on container start.

## Production (every customer, one command)

The installer is the only command. SINGULANCE Cloudflare owns DNS. No
trycloudflare. No customer Cloudflare account.

```bash
curl -fsSL https://get.singulancelabs.com/memory-box | sudo env HIVEMIND_ENROLLMENT_TOKEN='<token>' HIVEMIND_CENTRAL_URL='https://api.singulancelabs.com' bash
```

Each org gets a **permanent** pair on that box's named tunnel:

- Memory: `https://mb-<16hex>.singulancelabs.com`
- Harness UI: `https://hr-<16hex>.singulancelabs.com`

`setup.sh` writes `HARNESS_PUBLIC_URL` and trusts that host. Restarting the
box does not change the hostname.

This laptop uses the same pattern on a shared named tunnel:
`https://harness-see.singulancelabs.com/` (not a per-customer URL).

## One command (Memory Box + HyperAgent)

Same installer as Memory Box. After this change, `setup.sh` always starts
`--profile harness` as well:

```bash
curl -fsSL https://get.singulancelabs.com/memory-box | sudo env HIVEMIND_ENROLLMENT_TOKEN='<token>' HIVEMIND_CENTRAL_URL='https://api.singulancelabs.com' bash
```

Until that URL ships a release that includes `hivemind/harness-chat:byod-hyperagent`,
build the local tag first (`./run.sh` below) or set `BYOD_INITIAL_HARNESS_IMAGE`.

Harness UI on the box: `http://localhost:3080` (Connect to HIVEMIND).

## See it now (this machine)

One line. Compose cluster + a public URL printed in the terminal
(`*.trycloudflare.com`, SINGULANCE-account broker `hr-…` is still the product URL later):

```bash
cd byod/hyperagent && ./see.sh
```

Stable public URL (SINGULANCE Cloudflare named tunnel, does not rotate):

https://harness-see.singulancelabs.com/

Wildcard on the same tunnel: `*.harness-see.singulancelabs.com`.
Customer Memory Box enroll still uses `hr-<16hex>.singulancelabs.com`.

## Local E2E (this folder)

Needs local `hivemind-network` (HIVEMIND compose already up) and the
existing image `hivemind/harness-chat:c874825a6f57e38c073f53b5f9da88c93403ff2c`.

```bash
cd byod/hyperagent
./run.sh          # builds local tag hivemind/harness-chat:byod-hyperagent
./e2e.sh
# UI: http://127.0.0.1:13080
./run.sh down
```

`Dockerfile.hyperagent` does **not** rebuild Harness. It `FROM` the existing
runner image, sets `includeUserRoot: true`, and allows every shipped preset
so the native UI can switch mode and models.

Add an LLM in **Settings → Models** (credentials service). Do not set
`CLOUDFLARE_API_KEY` on the box. Until a key is saved there, turns report
`MISSING_CREDENTIAL`.

Visible product chrome is **SINGULANCE** (login-page DNA: Space Grotesk,
ivory `#faf9f4`, ink `#0a0a0a`, accent `#117dff`). Internal `__DSH_*` wires
stay native.


## Auth

Entrypoint requires `HIVE_HARNESS_TICKET_SECRET` and
`HIVE_HARNESS_RUNNER_SERVICE_SECRET` (≥32 chars, distinct). Local values live
in `.env` (from `env.example`). Usage in the UI still needs **Connect to
HIVEMIND** against Control Plane. This folder does not mint production tickets.

## Production URL

The broker assigns both hostnames on the same Cloudflare tunnel (no customer DNS):

- Agent: `https://mb-<16hex>.singulancelabs.com` → `http://agent:8787`
- Harness UI: `https://hr-<16hex>.singulancelabs.com` → `http://harness:3080`

Enroll returns `harnessUrl`. `setup.sh` writes `HARNESS_PUBLIC_URL` and
`HIVEMIND_HARNESS_PARENT_ORIGINS` so Connect to HIVEMIND trusts that origin.

Local E2E stays on `http://localhost:13080` until that broker is deployed.

## Out of scope here

- Production / `singulance-main` / preview Worker
- Engine Box
- hm-extract
- Chat preset (`hivemind-chat`)
- Customer k3s
