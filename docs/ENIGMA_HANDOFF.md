# Enigma Server and `enigma-main` — Cross-Laptop Engineering Handoff

**Snapshot:** 2026-09-13, Europe/Berlin  
**Audience:** a new coding session on a different laptop  
**Environment:** Enigma development URLs running with production-style release discipline  
**Canonical application branch:** `origin/enigma-main`  
**Do not merge into:** `singulance-main`  

This document is the portable source of truth for continuing Enigma work without
the original chat history. It records the current Git authorities, server
topology, immutable releases, Cloudflare routing, native Harness chat rollout,
tests already completed, known gaps, and safe continuation commands.

It deliberately contains **no secret values**. Secret names and their approved
locations are documented; retrieve values from the existing encrypted/local
runtime configuration, never from Git or chat transcripts.

---

## 1. Read this first

Enigma is the fresh SINGULANCE/HIVEMIND environment currently exposed through
the `dev.*` domains. It is intended to become a clean production environment
after certification, but it must remain operationally separate from the
existing Singulance production server.

The most important rules are:

1. **Enigma source authority is `origin/enigma-main`.** Do not deploy a local
   task branch or `singulance-main` to Enigma.
2. **Running artifacts are authoritative only when backed by a release
   manifest.** The operational checkout on the server is allowed to lag and is
   not evidence of what a container runs.
3. **Never patch a running container or generated frontend bundle.** Commit,
   push, build from a clean detached worktree, and recreate only the affected
   service.
4. **Reuse cached immutable images.** A configuration-only change should
   recreate only the affected service. Rebuild only when its source changed.
5. **Cloudflare is routing, admission, and optional orchestration—not memory
   truth.** PostgreSQL is the durable authority; Qdrant is rebuildable semantic
   projection; Redis is execution state.
6. **Never copy customer content or secrets into Cloudflare state, logs,
   commits, tickets, or handoff documents.**
7. **Do not touch `ssh singulance` while performing Enigma work.** Enigma is
   `root@159.195.204.36`.

Also read the repository-wide authorities before making changes:

- [`HANDOFF.md`](../HANDOFF.md)
- [`AGENTS.md`](../AGENTS.md)
- [`docs/BRANCH_PROTOCOL.md`](BRANCH_PROTOCOL.md)
- [`docs/PRODUCTION_RELEASE_PROTOCOL.md`](PRODUCTION_RELEASE_PROTOCOL.md)
- [`DEPLOY_GOVERNOR.md`](../DEPLOY_GOVERNOR.md)
- [`docs/PROGRESSIVE_HARNESS.md`](PROGRESSIVE_HARNESS.md)
- [`docs/PROGRESSIVE_HARNESS_ACCEPTANCE.md`](PROGRESSIVE_HARNESS_ACCEPTANCE.md)

Where a generic document says production is only `ssh singulance`, that rule is
for the existing production environment. This handoff adds the isolated Enigma
contract; it does not redefine Singulance production.

---

## 2. Current authorities and exact revisions

### 2.1 HIVE-MIND parent repository

| Item | Current value |
| --- | --- |
| Remote | `https://github.com/amar3012005/HIVEMIND.git` |
| Canonical Enigma branch | `enigma-main` |
| Current Enigma tip | `b1680c5b4c9f246dde3094d5833eed81022d2e12` |
| Tip subject | `fix(harness): configure native connected apps` |
| Working branch used for the rollout | `codex/enigma-harness-chat-e2e` |
| Current frontend gitlink | `7f7f6a0340aa333672b4fe6dc22b57f99b2dbab2` |

At this snapshot, the working branch and `origin/enigma-main` point to the same
commit and the rollout worktree is clean.

### 2.2 Da-vinci frontend submodule

| Item | Current value |
| --- | --- |
| Path | `frontend/Da-vinci` |
| Remote | `https://github.com/amar3012005/Da-vinci.git` |
| Branch | `enigma-main` |
| Pinned commit | `7f7f6a0340aa333672b4fe6dc22b57f99b2dbab2` |
| Commit subject | `chore(enigma): bind native Harness Worker on dev host` |

Always commit and push Da-vinci first, then commit the parent gitlink. Never
leave `enigma-main` pointing at a frontend commit that exists only locally.

### 2.3 Native Harness repository

The native chat runtime has its own repository and release authority.

| Item | Current value |
| --- | --- |
| Remote | `https://github.com/amar3012005/deepseek-harness-hivemind.git` |
| Working branch | `codex/enigma-authority-fix` |
| Current branch tip | `6955cd2562daf36b1c11713645681e5f9e17c214` |
| Deployed image source commit | `4e4351d40e12807cc25337e707f56222591c3cee` |
| Deployed image | `hivemind/harness-chat:sha-4e4351d40` |
| Deployed image ID | `sha256:8709ca50260052292f89a8ca3c5c5d3db286d10200fef0eecc6684e344acbcfe` |

The branch tip is newer than the deployed image. Commit `6955cd2562` changes
only the release verifier (`profile-smoke.mjs`) to make it self-contained. It
does **not** change the runner runtime and has not been deployed. Do not claim
that Enigma runs `6955cd2562`.

### 2.4 Why the server checkout does not match the branch tip

On the server:

- `/root/hivemind-main` is a clean detached operational checkout at
  `44db481a83978e6c73a2fa1986f4b4e2ff2ce2fe`.
- Its remote tracking ref `origin/enigma-main` correctly points to
  `b1680c5b4c9f246dde3094d5833eed81022d2e12`.
- Running application images were built from clean detached release worktrees
  and are recorded under `/root/releases/manifests/`.

This is intentional. **Do not run `git pull`, reset the checkout, or treat its
HEAD as the deployed version.** Inspect container labels/images and release
manifests instead.

---

## 3. Bootstrap a new laptop safely

The following creates a fresh, isolated task worktree from Enigma authority.
Replace `<topic>` with a short task name.

```bash
git clone https://github.com/amar3012005/HIVEMIND.git ~/HIVE-MIND
cd ~/HIVE-MIND
git fetch origin --prune
git worktree add -b codex/enigma-<topic> \
  ../HIVE-MIND-enigma-<topic> origin/enigma-main
cd ../HIVE-MIND-enigma-<topic>
git submodule update --init --recursive
git status --short --branch
git submodule status frontend/Da-vinci
```

Expected starting points at this snapshot:

```text
parent:   b1680c5b4c9f246dde3094d5833eed81022d2e12
Da-vinci: 7f7f6a0340aa333672b4fe6dc22b57f99b2dbab2
```

If either remote has advanced, do not force it back to this snapshot. Read the
new commits and update this handoff as part of the task.

For Harness runtime work, clone it separately:

```bash
git clone https://github.com/amar3012005/deepseek-harness-hivemind.git \
  ~/deepseek-harness-hivemind
cd ~/deepseek-harness-hivemind
git fetch origin --prune
git worktree add -b codex/enigma-<topic> \
  ../deepseek-harness-enigma-<topic> origin/codex/enigma-authority-fix
```

Before planning or editing, follow the repository's ICARUS bootstrap and
context rules from `AGENTS.md`. Never manually invent `.icarus` state.

### SSH

The Enigma host is:

```bash
ssh root@159.195.204.36
```

Verify identity before operations:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 root@159.195.204.36 \
  'hostname && id && docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"'
```

Expected hostname at this snapshot: `v2202609412644514416`.

Do not place passwords, tokens, cookies, or API keys in shell arguments or
command output. If SSH access is missing on a new laptop, transfer only the
public key through the provider console or an already trusted channel.

---

## 4. Environment and public routing

### 4.1 Public endpoints

| Function | Enigma endpoint |
| --- | --- |
| Frontend / HIVE shell | `https://dev.next.singulancelabs.com` |
| Public Control Plane API | `https://api.dev.next.singulancelabs.com` |
| Public Core API | `https://core.dev.next.singulancelabs.com` |
| Native Harness private origin | `https://harness-chat-origin.dev.next.singulancelabs.com` |
| Admin surface | `https://admin.hivemind.singulancelabs.com` with environment selection |

URLs must come from the environment/public-origin contract. Do not hardcode
production `next.singulancelabs.com`, `api.singulancelabs.com`, or
`core.singulancelabs.com` into shared code. A future promotion should require a
single environment-domain change, not scattered source edits.

### 4.2 Cloudflare delivery

- Da-vinci is deployed through Cloudflare, not Vercel and not the Enigma VPS.
- `hivemind-dev-cloudflared.service` is the active outbound-only tunnel on the
  Enigma host.
- The native Harness edge Worker is configured in
  `workers/harness-chat/wrangler.enigma.jsonc`.
- Worker name: `hivemind-harness-chat-enigma`.
- It proxies authenticated native Harness traffic to the private Harness
  origin and serves the same-origin browser shell/assets.
- Feature admission is evaluated through Cloudflare Flagship.

### 4.3 Harness rollout flag

| Item | Value |
| --- | --- |
| Flagship application ID | `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` |
| Flag key | `hivemind_harness_chat_v1` |
| Valid variants | `legacy`, `preview`, `harness` |
| Current canary org | `783fdaac-a407-4571-9d7b-6b561c49ddb6` |
| Current canary user | `f483cb30-d027-48e7-aa5f-19c5e4460269` |
| Current canary result | `harness`, reason `TARGETING_MATCH` |

The Worker fails closed. Invalid scope, provider failure, or invalid variation
must preserve the legacy path. The selected mode is latched at admission so a
mid-turn flag change cannot split one session between runtimes.

Rollback is immediate and does not require an image rebuild: change the exact
targeted Flagship rule from `harness` to `legacy`. Do not delete the rule or
broaden it to every tenant while investigating.

---

## 5. Live Enigma topology

The server is a single-host Docker Compose deployment using project name
`enigma` and `infra/docker-compose.hetzner.yml`. The host currently runs Debian
13 on amd64. PostgreSQL, Qdrant, and Redis are not publicly bound.

### 5.1 Running containers at this snapshot

| Container | Image | Role | State |
| --- | --- | --- | --- |
| `hm-core` | `hivemind/core-api:sha-c4f1059a` | memory engine, ingestion API, recall, chat, MCP | healthy |
| `hm-control` | `hivemind/control-plane:sha-655ebe78` | browser auth, public API, policy, lifecycle | healthy |
| `hm-employees` | `hivemind/employees:sha-655ebe78` | HyperAgents / company rooms | healthy |
| `hm-ingestion-worker` | `hivemind/core-api:sha-ff1f02af` | isolated durable ingestion execution | healthy |
| `enigma-harness-runner-1` | `hivemind/harness-chat:sha-4e4351d40` | native Harness chat runtime | healthy |
| `hm-extract` | `hivemind/hm-extract:sha-4153c92ff9` | local document extraction | healthy |
| `hm-byod-broker` | `hivemind/byod-broker:sha-4153c92ff9` | Memory Box/BYOD broker | healthy |
| `hm-playwright` | `hivemind/hm-playwright:sha-4153c92ff9` | governed browser runtime | healthy |
| `tara-deepgram` | `hivemind/tara-deepgram:sha-4153c92ff9` | voice/transcription path | healthy |
| `hm-postgres` | `hivemind/postgres-age:15-age-custom` | durable relational/graph authority | healthy |
| `hm-qdrant` | `qdrant/qdrant:v1.12.4` | rebuildable semantic index | running |
| `hm-redis` | `redis:7-alpine` | queues, locks, ephemeral execution state | running |
| `hm-nango` | `nangohq/nango-server:hosted` | connector authorization/runtime | running |
| `hivemind-dev-cloudflared` | immutable Cloudflare image ID | outbound tunnel | running |

These services intentionally run different exact SHAs because releases were
scoped. Do not report the whole platform as running `b1680c5b4`; that commit is
the source branch tip, not a universal container revision.

### 5.2 Host port bindings

| Service | Host binding |
| --- | --- |
| Core | `127.0.0.1:2026 -> 3000` |
| Control Plane | `127.0.0.1:2027 -> 3000` |
| Harness runner | `127.0.0.1:3080 -> 3080` |
| Nango | `127.0.0.1:3003 -> 8080` |
| BYOD broker | `127.0.0.1:8790 -> 8790` |
| Playwright MCP | `127.0.0.1:8932 -> 8932` |
| TARA Deepgram | `127.0.0.1:8091 -> 8091` |

Internal data services and workers communicate over Docker DNS and are not
bound publicly.

### 5.3 Correct health probes

Core listens on port 3000 **inside** the container and on 2026 at host
loopback. Do not probe host port 3000 and misdiagnose a failure.

```bash
ssh root@159.195.204.36 \
  'docker exec hm-core node -e '\''fetch("http://127.0.0.1:3000/health").then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'\'''

ssh root@159.195.204.36 \
  'docker exec enigma-harness-runner-1 node -e '\''fetch("http://127.0.0.1:3080/health").then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'\'''
```

At this snapshot both return HTTP 200. Health is necessary but does not replace
authenticated acceptance.

---

## 6. Data and execution architecture

### 6.1 Memory and ingestion authority

```text
source adapter / upload
        -> durable admission and idempotency
        -> local hm-extract or specialized parser
        -> canonical document + evidence persistence in PostgreSQL
        -> optional curated memory generation
        -> canonical entity/relationship/provenance projection
        -> Qdrant vector projection
        -> vector coverage/reconciliation gate
        -> ready
```

- PostgreSQL owns documents, evidence, memories, metadata, provenance,
  permissions, entities, relationships, durable job state, and lexical recall.
- Qdrant stores semantic projections. It must be rebuildable from PostgreSQL.
- A Qdrant outage must not be converted to zero hits. PostgreSQL lexical recall
  should return grounded results with an explicit degraded semantic lane.
- The isolated ingestion worker protects Core/chat latency.
- Cloudflare Workflow/Queue state may contain only content-free identifiers and
  coarse execution status. Customer bytes, extracted text, chunks, embeddings,
  filenames, prompts, answers, and raw error bodies stay on Enigma.
- BullMQ remains the bounded fallback when Cloudflare admission/execution is
  unavailable; PostgreSQL job state remains recovery authority.
- Docling is retired from the Enigma runtime. `hm-extract` remains active.
- Direct Groq/xAI routing is disabled. Model traffic uses the configured
  Cloudflare AI Gateway/OpenRouter route.

### 6.2 Native Harness chat request path

```text
Da-vinci HIVE shell
  -> Control Plane authenticated bootstrap/new-session
  -> server-derived org/user scope
  -> Flagship evaluation
  -> short-lived, tenant-scoped, one-use admission ticket
  -> same-origin Cloudflare Harness Worker
  -> private tunnel origin
  -> native Harness runner
  -> PostgreSQL session/event persistence + Redis execution state
  -> scoped Core company-brain proxy
  -> streamed result back through the same origin
```

Important boundaries:

- The browser cannot select `org_id` or `user_id` authority.
- Ticket nonce is consumed once.
- Company-brain access uses a separate short-lived service credential.
- Session deletion is tenant scoped and returns a durable receipt.
- Existing legacy chat remains the flag-off fallback.
- Native Harness usage is projected into the existing content-free AI usage
  ledger from durable `assistant/message` events.

### 6.3 Connected apps

The Harness runner receives server-held `COMPOSIO_API_KEY` and a configured
callback URL. These values are not sent to the browser or persisted in Harness
session events.

Discovery and OAuth-card rendering are verified for Gmail and Slack. A real
connected read, OAuth resume across restart, and approved external write are
still intentionally unproven because those actions require explicit user
authorization. Never treat a rendered authorization card as a connected app or
completed action.

### 6.4 Usage projection

Migration:

```text
core/prisma/migrations/20260913143000_harness_chat_usage_projection/migration.sql
```

It projects native Harness `assistant/message` usage into
`hivemind.ai_usage_events`. The projection is content-free and idempotent. A
verified canary produced:

```text
use_case: harness_chat
status: completed
model: openrouter/deepseek/deepseek-v4-flash-0731
prompt tokens: 4191
completion tokens: 5
```

The trace was bound to the durable session ID; message content was not copied
into the usage ledger.

---

## 7. What changed on `enigma-main`

`enigma-main` and `singulance-main` have intentionally diverged. At this
snapshot their merge base is:

```text
b28f072d5e996639b765076b184ced687ed6b8eb
```

There are 102 Enigma-side commits and 37 Singulance-side commits after that
base. Therefore:

- Enigma is **not** simply “the latest Singulance plus dev URLs.”
- Do not merge either branch wholesale into the other.
- Port features deliberately, with tests and feature flags.
- Recompute the comparison before every sync because the counts will drift.

Use this command to read the complete history on a new laptop:

```bash
git fetch origin --prune
base=$(git merge-base origin/enigma-main origin/singulance-main)
git log --reverse --date=iso --format='%h %ad %s' \
  "$base"..origin/enigma-main
git diff --stat "$base"..origin/enigma-main
git log --left-right --graph --cherry-pick --oneline \
  origin/singulance-main...origin/enigma-main
```

### 7.1 Curated history map

The following groups explain the Enigma-only development sequence. Read the
actual commit diff before modifying any of these areas.

#### Portable release and environment isolation

- `fdb8b62b4`, `49a4c8e88` — safe Enigma runtime environment synchronizer.
- `fda129116`, `7f32b2941` — permit the Enigma branch through release admission.
- `44db481a8`, `2bbdf8420` — pass the selected release branch to the canonical
  runner.
- `efd942038`, `65e1c5f89` — make runtime roots configurable.
- `3e97e243b`, `16f04fb38` — run migrations using the resolved Compose
  environment.
- `a79937e29`, `5d7351c35` — preserve the `enigma` Compose project/network.
- `92f0db7b6`, `d1e836e74` — pin isolated frontend releases.

#### URL, authentication, and fresh-tenant correctness

- `df9e9698c`, `2f0475072` — isolate frontend origins and cover links.
- `8ff0eebe7`, `6cd4f7736` — keep activation results iterable after auth.
- `0e2ea0109` — derive auth fallback from the configured public frontend.
- `266c7de63`, `09e7b2e9d`, `fbefb0997`, `e50866714` — make public origin the
  single URL ground truth for lifecycle links and transactional email assets.
- `77206e679`, `c3bc2359e` — return valid empty company state for a fresh org.
- `e5721ea02`, `65caff364` — fail clearly when email provisioning is
  unavailable.

#### Activation lifecycle and rooms

- `58827bcfb` — gate the pre-Day-0 activation lifecycle through Flagship.
- `750827e77` — expose the activation timeline to platform administrators.
- `619c3ce74` — admit voice/operating rooms through Flagship.
- `32ee69244` — isolate the canonical projection worker.

#### Entity discovery and filtered recall

- `115f13932` — add feature-gated lexical entity discovery.
- `4fd92874b` — search the canonical entity registry.
- `1b5cb66f8` — authorize entity links through tenant storage.
- `62e6fd743`, `ac138089d` — discover authorized agent-tag entities and test
  the behavior.
- `d92dba69e` — preserve strictly selected entity filters in recall.
- `6ae6c004b` — enforce remote temporal snapshots.

#### Ingestion durability, canonical projection, and backups

- `c72befcf6` — harden Enigma ingestion recovery and isolation.
- `a26429e39` — deploy the isolated ingestion worker immutably.
- `c08ffa5a7` — query the canonical ingestion schema operationally.
- `1df9f705c`, `ae9d8741b` — route Enigma Workflow admission and callbacks to
  Core.
- `5b50102ce` — distinguish Qdrant outage from genuine zero hits.
- `ffdcfeb09`, `c9b1665ef`, `f40015a22` — Enigma backups, scheduled restore
  drills, and stable backup workdirs.
- `61239daf7` — redact Workflow step state.
- `5a0354c9f`, `1eb575766`, `e7c1960be`, `a4d77c0d6` — enforce one canonical,
  atomic write path and close bypasses.
- `20f83a714`, `d72a499d1`, `7fd7df752`, `1db290bdd` — require complete memory,
  evidence/document-summary vector coverage and repair receipts.
- `035befc23`, `f75a21fcb`, `f6d25d9f4`, `31cc20251` — canonical entity
  indexing, document-summary entities, resumable checkpoints, and coverage.
- `289e5b86c`, `fc7535a34`, `13b70b718`, `feb05c807` — delete/replace stale
  projections safely.
- `ffc285453`, `3bbc2150f`, `45c79a08b`, `2a17eba41` — grounded source
  coverage, model-free enterprise names, canonical entity/document quality,
  and source-language/entity gap fixes.
- `234439e95`, `2ab7041a8`, `1c83dd2a7` — retire Docling while preserving and
  correctly routing `hm-extract`.
- `3083f840f`, `e610b0be9`, `ff1f02af7` — disable direct Groq/xAI paths and
  fail closed where direct Grok is unavailable.

#### Native Harness chat

- `661e8d691` — tenant-scoped session persistence schema.
- `5942807ca` — authenticated Control Plane bootstrap tickets.
- `3b3f310fb` — Harness edge Worker and runner service.
- `9ca895a3c`, `3823cdf70`, `74fe2e708` — scope hardening and authority/origin
  contract completion.
- `f0faa669d` — company-brain proxy with scoped runner identity.
- `31f705de8` — server-derived admission diagnostics and same-origin proxy.
- `bab2eaced` — hardened native chat preview lifecycle.
- `684a12eb0` — ensure new-session creation honors rollout mode.
- `655ebe78e` — production-style Enigma release preparation.
- `2d4b90a11` — immutable runner asset proxying.
- `2568d789c` — tunnel-host trust for admission.
- `53096ea67` — pin the verified Harness runner image.
- `2ff5ce6b6` — trust the public Enigma authority.
- `95c8ac4c3` — inject the Cloudflare Gateway credential into the runner.
- `c4f1059ad` — idempotent native chat usage metering.
- `b1680c5b4` — native connected-app configuration.

### 7.2 Harness repository history relevant to Enigma

- `d20de77f23` — fingerprint Composio schemas.
- `e790b4fa73` — deduplicate completed connected writes.
- `7d0c0d333b` — retain bounded pagination cursors.
- `fed5734e12`, `b2dcc4d1f6` — authenticated profile context with bounded,
  deferred learning.
- `2de3e2569a` — narrow recall with canonical entities.
- `c1dff3f2f5` — trust the proxy-pinned public authority.
- `bd0fe9cc96`, `4e4351d40e` — verify provider reasoning policy and registry;
  `4e4351d40e` is the deployed runtime source.
- `6955cd2562` — self-contained image profile smoke verifier; not deployed.

---

## 8. Source map for current native chat work

| Concern | Primary source |
| --- | --- |
| Bootstrap, new session, delete, scoped Core proxy | `core/src/routes/harness-chat.js` |
| Ticket signing/verification | `core/src/harness-chat/admission-ticket.js` |
| Runner service identity | `core/src/harness-chat/runner-service-token.js` |
| Public Control Plane route mounting | `core/src/control-plane-server.js` |
| Session/event schema | `core/prisma/schema.prisma` and Harness migrations |
| Usage projection | `core/prisma/migrations/20260913143000_harness_chat_usage_projection/migration.sql` |
| Compose runner contract | `infra/docker-compose.hetzner.yml` |
| Release lock | `infra/harness-chat-release.lock.json` |
| Immutable image builder | `scripts/release-harness-chat-runner` |
| Cloudflare edge proxy | `workers/harness-chat/src/index.ts` |
| Enigma Worker config | `workers/harness-chat/wrangler.enigma.jsonc` |
| Edge tests | `workers/harness-chat/tests/flag.test.ts` |
| Core contract tests | `core/tests/unit/harness-chat-*.test.js` |
| Da-vinci native route/shell | `frontend/Da-vinci` at the pinned gitlink |
| Harness runtime/profile | separate `deepseek-harness-hivemind` repository |

Use structural graph tools first as required by `AGENTS.md`, then targeted file
reads when the graph lacks coverage. Do not explore the entire repository with
broad unbounded scans.

---

## 9. Release procedure for Enigma

### 9.1 Before release

1. Work only in a clean task worktree based on `origin/enigma-main`.
2. Fetch both repositories and confirm the intended parent/frontend SHAs.
3. Run focused tests, syntax/type checks, and `git diff --check`.
4. Commit and push Da-vinci first if it changed.
5. Commit the parent gitlink and push the parent branch.
6. Rebase/reconcile onto the latest `origin/enigma-main`; rerun tests.
7. Fast-forward or merge the completed task into `enigma-main` without
   contaminating `singulance-main`.
8. Verify the exact remote SHA before contacting the server.
9. Check active release presence/locks and create a verified backup for schema,
   auth, billing, ingestion, or storage changes.

### 9.2 Canonical backend release

The Enigma entrypoint is `/root/quick-deploy-enigma.sh`. It fetches the exact
selected branch, executes `scripts/release-canonical.sh` from that SHA, creates
a detached worktree, builds immutable images, applies guarded migrations, and
writes a release manifest.

Service-scoped example:

```bash
ssh root@159.195.204.36 \
  'RELEASE_SESSION_ID=<short-topic> /root/quick-deploy-enigma.sh enigma-main core'
```

Coupled runtime example:

```bash
ssh root@159.195.204.36 \
  'RELEASE_SESSION_ID=<short-topic> /root/quick-deploy-enigma.sh enigma-main core control-plane employees'
```

Run it in the foreground and wait for `RELEASE OK`. Do not use an old mutable
rollback shortcut; it is intentionally rejected. Roll back by releasing the
exact previously recorded SHA/image from the relevant manifest.

### 9.3 Configuration-only runner change

If only runner environment/configuration changed and the runtime source did not:

1. Back up `/root/hivemind/.env` with a timestamp.
2. Update only the required secret reference/config key without printing its
   value.
3. Render and validate Compose.
4. Reuse `hivemind/harness-chat:sha-4e4351d40`.
5. Recreate only `harness-runner` with the `harness-chat` profile.
6. Verify container/image identity, health, public browser behavior, durable
   session persistence, and logs.
7. Write a config-only release manifest.

The latest example is:

```text
/root/releases/manifests/b1680c5b4/harness-runner-config/RELEASE_MANIFEST.json
```

### 9.4 Build a new Harness runner image

Only do this when Harness runtime source changes. Update the exact expected
Harness commit in both:

- `scripts/release-harness-chat-runner`
- `infra/harness-chat-release.lock.json`

The builder refuses a dirty tree or a mismatched commit and runs the image
verifier before acceptance.

```bash
scripts/release-harness-chat-runner \
  /path/to/clean/deepseek-harness-worktree \
  hivemind/harness-chat
```

Do not retag a changed image under an existing `sha-*` tag.

### 9.5 Frontend and Worker

- Da-vinci is deployed from its own repository through Cloudflare.
- The Harness Worker is tested from `workers/harness-chat` and deployed using
  `wrangler.enigma.jsonc`.
- Confirm exact Cloudflare Worker version and route after deployment.
- A Worker deploy does not prove browser acceptance; run the signed-in flow.

Never deploy frontend assets from the Enigma VPS.

---

## 10. Verification already completed

### 10.1 Source/contract tests

At HIVE commit `b1680c5b4` the rollout passed:

- 17 focused Control Plane/Core Harness tests.
- 16 Harness Worker tests.
- Worker TypeScript typecheck.
- canonical Compose rendering.
- exact Da-vinci gitlink verification.
- syntax checks and `git diff --check`.
- direct Grok/xAI disabled regression tests.

The ICARUS HIVE task was `TASK-8A2710CAF80D`. It reached verification with
passing acceptance receipts. Sealing was blocked because ICARUS inspected the
dirty shared root checkout rather than the clean bound worktree and listed
unrelated files. Do not revert those unrelated files. Treat this as task-state
bookkeeping, not a source/test failure.

The earlier Harness ICARUS task `TASK-02D6E6D6C388` is terminal failed because
its first image smoke depended on a workspace package unavailable inside the
image. Commit `6955cd2562` makes the smoke verifier self-contained. A direct
verification inside the immutable deployed image passed all required profile
rows; create a fresh ICARUS task if formal resealing is required.

### 10.2 Browser/session acceptance

Verified on `https://dev.next.singulancelabs.com`:

- native route admitted for the targeted Flagship org/user;
- creating a new session produced a distinct durable session ID;
- prompt `Reply with exactly STREAM-OK. Do not call tools.` streamed
  `STREAM-OK`;
- hard refresh preserved the session URL and response;
- browser back/forward restored the correct old/new sessions;
- sidebar collapse/expand preserved the composer;
- both session rows and events persisted in PostgreSQL;
- native usage projected once into the AI usage ledger.

Verified session IDs:

```text
session-491e25d8-3e41-4d3d-b45f-10ded2845671
session-dfd0cac9-e596-44ca-a0ae-dd34f53ee91e
```

These IDs are diagnostic references, not authentication credentials.

### 10.3 Rollback acceptance

The exact targeted Flagship rule was temporarily changed from `harness` to
`legacy`. The browser immediately rendered the legacy Overview path. The
original normalized rule was then restored and the browser returned to native
Harness. No service/image rebuild was required.

### 10.4 Connected-app negative/cancel path

Gmail and Slack requests rendered correct Composio OAuth cards. The turn was
cancelled using “Dismiss and stop this turn.” Durable `tool/call`,
`hivemind/composio-session`, `tool/result`, and `turn/end` receipts persisted.
This proves the authorization-required and cancellation path, not a completed
external action.

---

## 11. Release manifests, backups, and operations

### 11.1 Important release manifests

| Purpose | Manifest |
| --- | --- |
| Current Core release | `/root/releases/manifests/c4f1059a/20260913T184136Z/RELEASE_MANIFEST.json` |
| Runner connected-app config | `/root/releases/manifests/b1680c5b4/harness-runner-config/RELEASE_MANIFEST.json` |
| Core/Control/Employees baseline | `/root/releases/manifests/655ebe78/20260913T165714Z/RELEASE_MANIFEST.json` |
| Ingestion worker baseline | `/root/releases/manifests/ff1f02af/20260913T162736Z/RELEASE_MANIFEST.json` |

The Core manifest records rollback to `hivemind/core-api:sha-655ebe78`.

### 11.2 Backups and drills

- Managed backups: `/opt/enigma/backups-managed/`
- Fresh verified snapshot: `/opt/enigma/backups-managed/20260913T183838Z`
- Contents include PostgreSQL dump, Qdrant snapshot, AMR data archive, and a
  storage manifest.
- Daily backup timer: `enigma-backup.timer`.
- Weekly restore drill: `enigma-restore-drill.timer`.
- Five-minute content-free ingestion durability check:
  `enigma-ingestion-ops-check.timer`.

The backup service intentionally treats exit code 2 as a locally verified
encrypted backup with no off-host destination. **Off-host replication remains
open.** Do not call Enigma disaster-recovery complete until an encrypted remote
copy and clean-host restore are proven.

Check operations without exposing payloads:

```bash
ssh root@159.195.204.36 \
  'systemctl list-timers --all --no-pager | grep -E "enigma-(backup|restore-drill|ingestion-ops-check)"'

ssh root@159.195.204.36 \
  'systemctl status enigma-ingestion-ops-check.service --no-pager; journalctl -u enigma-ingestion-ops-check.service -n 80 --no-pager'
```

Do not print raw job payloads or document names while checking durability.

---

## 12. Secret and configuration discipline

Runtime configuration lives at:

```text
/root/hivemind/.env
```

The latest runner configuration backup is:

```text
/root/hivemind/.env.bak-harness-connected-20260913T184726Z
```

Important configured secret/configuration names include:

- `POSTGRES_*`, `REDIS_PASSWORD`, `QDRANT_API_KEY`
- `ZITADEL_*`
- `GOOGLE_*`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AI_GATEWAY_*`
- `CLOUDFLARE_EMAIL_*`
- `CLOUDFLARE_REALTIMEKIT_*`
- `OPENROUTER_*`
- `COMPOSIO_API_KEY`
- `HIVE_HARNESS_*`
- `HIVEMIND_HARNESS_IMAGE`
- `HIVEMIND_CONNECTED_APP_CALLBACK_URL`

Rules:

1. Never paste values into Git, issues, logs, or this handoff.
2. Do not copy the full production `.env` into a new checkout.
3. Read only key names when reconciling configuration.
4. Back up the runtime file before a change and keep mode 600.
5. Rotate any credential accidentally disclosed in chat or terminal output.
6. Direct provider keys must not be added to the Harness runner; it receives the
   Cloudflare Gateway credential under the provider-compatible runtime name.
7. The absence of a legacy provider key in Compose diagnostics is not a runtime
   outage when the direct route is intentionally disabled.

---

## 13. Known gaps and next priority work

Enigma is substantially functional, but these are still open before calling it
the final production environment:

### P0 — User-authorized connected-app proof

With explicit user approval, prove:

1. a real Gmail or Slack OAuth connection completes;
2. the authorization flow resumes after a runner restart;
3. a connected read returns through the native Harness turn;
4. an approved external write produces an idempotent durable receipt;
5. cancellation/rejection continues to produce no side effect.

Do not simulate approval or use a guessed recipient.

### P0 — Off-host disaster recovery

Configure encrypted backup replication to an independent destination, keep the
encryption key outside that destination, restore onto a clean replacement host,
and record the signed/verified receipt.

### P1 — Formal Harness verifier reseal

Run the self-contained verifier at `6955cd2562` in a fresh governed task. Build
a new runner image only if the runtime source itself changes; otherwise this is
test-infrastructure closure.

### P1 — Full production certification

Before moving from `dev.*` to final production domains, repeat authenticated
canaries for:

- invitation, email OTP, Google/ZITADEL login, onboarding, and Day 0 lifecycle;
- evidence-only and both-mode ingestion;
- exact counts/provenance and vector coverage;
- entity discovery and strict entity-filtered recall;
- Qdrant outage -> lexical degraded recall;
- Qdrant rebuild from PostgreSQL;
- direct/SSE chat and native Harness sessions;
- MCP authentication and representative tool matrix;
- Operating Room/RealtimeKit admission and consent;
- HyperAgents company-room flow;
- backup, restore, rollback, and Cloudflare outage behavior;
- fresh fatal/OOM/migration/error-log scans.

### P1 — Branch reconciliation policy

Because both `enigma-main` and `singulance-main` continue to advance, establish
a recurring reviewed porting ledger. Never solve the divergence with an
unreviewed bulk merge.

---

## 14. Troubleshooting guide

### “The server repo is behind `enigma-main`”

Expected. Check `refs/remotes/origin/enigma-main`, container image labels, and
release manifests. Do not pull/reset the operational checkout.

### “Host `127.0.0.1:3000` refuses connection”

Expected. Core binds host loopback 2026 and container port 3000. Probe the
container or `127.0.0.1:2026`.

### Native route falls back to legacy

Check in this order:

1. authenticated session and active organization membership;
2. Flagship result for the exact org/user;
3. Control Plane bootstrap diagnostic without exposing the ticket;
4. Worker version/route and same-origin cookie behavior;
5. tunnel and private runner origin;
6. runner health and trusted public authority;
7. fresh Control Plane/Worker/runner logs.

Fix the first demonstrably failing boundary. Do not change routing, tunnel,
frontend, and credentials simultaneously.

### Composio OAuth card appears but no tool result

The card is an authorization request, not a connection. Complete OAuth with
explicit user approval, then resume the same durable session and inspect
receipts.

### Compose warns that a direct provider key is absent

First distinguish source-level interpolation warnings from the running
container environment. Direct Groq/xAI is intentionally disabled on Enigma.
Do not restore a direct provider secret merely to silence a diagnostic.

### Qdrant is unavailable

Do not return fabricated zero hits. Verify PostgreSQL lexical recall continues
with explicit degraded semantic status, then rebuild Qdrant from PostgreSQL and
run vector coverage reconciliation.

### An ingestion job stays queued/processing

Check PostgreSQL durable job state and the content-free operations watchdog,
reconcile Cloudflare Workflow state, resume the same idempotent job, and use
BullMQ fallback only when Workflow admission/execution is unavailable. Never
copy content into Queue/Workflow state to repair it.

---

## 15. First 30 minutes for the next coding session

1. Clone/fetch and create a clean worktree from `origin/enigma-main`.
2. Initialize submodules and verify the Da-vinci gitlink.
3. Read the authority documents listed in section 1.
4. Run the required ICARUS context bootstrap.
5. Recompute the `enigma-main`/`singulance-main` merge base and read all new
   Enigma commits since this snapshot.
6. SSH to Enigma and capture content-free state:
   - hostname;
   - containers/images/health;
   - remote Enigma ref;
   - latest release manifests;
   - timers and latest backup manifest;
   - disk and memory pressure;
   - recent fatal/OOM/migration errors.
7. Evaluate the targeted Harness flag without changing it.
8. Open the signed-in dev UI and verify the existing native session still
   loads before making changes.
9. Declare the exact files/services owned by the task.
10. Make the smallest change, add regression coverage, release only the
    affected unit, and verify the complete user-visible lifecycle.

Useful read-only status command:

```bash
ssh root@159.195.204.36 '
  echo "HOST=$(hostname)"
  echo "REMOTE_ENIGMA=$(git -C /root/hivemind-main rev-parse refs/remotes/origin/enigma-main)"
  docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}" | sort
  systemctl list-timers --all --no-pager | grep -E "enigma|hivemind"
  find /root/releases/manifests -name RELEASE_MANIFEST.json -type f -print | sort | tail -20
'
```

---

## 16. Handoff completion criteria for future sessions

Before handing Enigma to another agent or laptop, update this document with:

- new `origin/enigma-main` and Da-vinci SHAs;
- any Harness source/image revision change;
- exact running service images and release manifests;
- migrations applied;
- tests and authenticated canaries executed;
- Cloudflare Worker/flag changes and rollback reference;
- backup/restore evidence;
- intentionally untested external side effects;
- remaining blockers, with the first failing boundary;
- confirmation that `singulance-main` and the Singulance server were untouched.

The standard for “done” is not a successful build or green `/health`. It is a
clean, pushed source chain; an immutable, recorded release; persisted lifecycle
evidence; authenticated browser/API acceptance; a proven rollback; and a
precise list of anything still requiring user authorization.
