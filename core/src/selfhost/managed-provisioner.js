// managed-provisioner.js — flag-gated MANAGED-ENTERPRISE agent provisioner.
//
// Purpose: when a PAID / MANAGED enterprise org is created, give it its OWN .amr
// data plane (agent + Postgres + Qdrant) running in OUR cloud, on the same engine
// host as hm-core, and register it in the shared BYOD agent registry. Managed
// enterprise then uses the EXACT SAME data plane as self-host (Model B): the core
// engine processes memories centrally and POSTs the finished memory to the org's
// own hm-agent (/v1/write, /v1/recall, /v1/hydrate). The only difference vs
// self-host is WHERE the box lives (our cloud, not the customer's) — the registry
// entry shape and the core's routing are identical.
//
// SAFETY: this whole module is DORMANT unless MANAGED_AGENT_PROVISION === 'true'.
// It must NEVER throw out of the top-level call — org creation is fire-and-forget
// on this and must never break. Every failure path logs and returns
// { provisioned:false, ... }.
//
// ── HOST-REACHABILITY ASSUMPTION (read before changing networking) ────────────
// hm-core and the per-org containers run on the SAME engine host (Docker on one
// box). We give each org a dedicated docker network `hm-org-<short>` and join the
// three org containers to it (postgres / qdrant / agent talk to each other by
// container DNS name). For hm-core → org-agent reachability we PUBLISH the agent
// on a host port bound to 127.0.0.1 (loopback only — never 0.0.0.0, the agent is
// an internal hop, not public) and resolve the registry `url` as
// http://<HOST_GATEWAY>:<port>. HOST_GATEWAY defaults to host.docker.internal,
// which Docker maps to the host loopback when hm-core is started with
// `--add-host=host.docker.internal:host-gateway` (true in our compose). If hm-core
// instead shares a docker network with the org containers, set
// MANAGED_AGENT_NETWORK_MODE=shared + MANAGED_AGENT_SHARED_NETWORK=<net> and the
// url resolves to the agent's container DNS name on that shared network.
//
// pgUrl / qdrantUrl in the registry must be reachable FROM hm-core (not from the
// agent). With the published-host-port model we publish postgres + qdrant on
// loopback host ports too, and point pgUrl/qdrantUrl at the host gateway. With the
// shared-network model we point them at the container DNS names.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const execFile = promisify(_execFile);

const REGISTRY_FILE = () => process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
const AGENT_IMAGE = process.env.MANAGED_AGENT_IMAGE || 'hivemind/hm-agent:latest';
const POSTGRES_IMAGE = process.env.MANAGED_POSTGRES_IMAGE || 'postgres:16-alpine';
const QDRANT_IMAGE = process.env.MANAGED_QDRANT_IMAGE || 'qdrant/qdrant:latest';
// host alias hm-core uses to reach the published loopback ports on the engine host
const HOST_GATEWAY = process.env.MANAGED_AGENT_HOST_GATEWAY || 'host.docker.internal';
const NETWORK_MODE = process.env.MANAGED_AGENT_NETWORK_MODE || 'hostport'; // 'hostport' | 'shared'
const SHARED_NETWORK = process.env.MANAGED_AGENT_SHARED_NETWORK || '';
const DOCKER_BIN = process.env.MANAGED_DOCKER_BIN || 'docker';
const POSTGRES_USER = 'hivemind';
const POSTGRES_DB = 'hivemind';

const DOCKER_TIMEOUT_MS = 120000;

function log(event, fields) {
  try {
    console.log(JSON.stringify({ svc: 'managed-provisioner', event, ...fields }));
  } catch {
    /* logging must never throw */
  }
}

// short, docker-safe id derived from the org id (lowercase alnum, capped)
function shortId(orgId) {
  return String(orgId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || crypto.randomUUID().slice(0, 12);
}

async function docker(args, { timeout = DOCKER_TIMEOUT_MS } = {}) {
  return execFile(DOCKER_BIN, args, { timeout });
}

// true if a container with this exact name already exists (any state) — idempotency check
async function containerExists(name) {
  try {
    const { stdout } = await docker(['ps', '-aq', '-f', `name=^${name}$`], { timeout: 15000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function ensureNetwork(network) {
  if (NETWORK_MODE === 'shared') return; // shared network is operator-managed; don't create
  try {
    await docker(['network', 'inspect', network], { timeout: 15000 });
    return; // already exists
  } catch {
    /* not found — create it */
  }
  try {
    await docker(['network', 'create', network], { timeout: 30000 });
  } catch (e) {
    // race: another concurrent provision created it between inspect and create
    if (!/already exists/i.test(e?.stderr || e?.message || '')) throw e;
  }
}

// Allocate a free loopback TCP port for a published container port. Best-effort:
// the OS hands us an ephemeral port, we close it, then bind it in `docker run`.
// Small TOCTOU window is acceptable for a dormant best-effort scaffold.
function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Run a container if it doesn't already exist. Returns {created:boolean}.
async function runContainer(name, runArgs) {
  if (await containerExists(name)) {
    log('container_reused', { name });
    return { created: false };
  }
  await docker(['run', '-d', '--name', name, '--restart', 'unless-stopped', ...runArgs]);
  log('container_created', { name });
  return { created: true };
}

/**
 * Provision (or reuse) a managed-enterprise org's own .amr data plane.
 * Best-effort + idempotent + never throws.
 *
 * @param {{ orgId: string, dim?: number }} params
 * @returns {Promise<{provisioned:boolean, url?:string, registered?:boolean, reason?:string, error?:string}>}
 */
export async function provisionManagedAgent({ orgId, dim = 1024 }) {
  // Gate: ships dormant. Flip MANAGED_AGENT_PROVISION=true on the engine host to enable.
  if (process.env.MANAGED_AGENT_PROVISION !== 'true') {
    return { provisioned: false, reason: 'disabled' };
  }
  if (!orgId) {
    return { provisioned: false, reason: 'no-orgId' };
  }

  try {
    const sid = shortId(orgId);
    const network = `hm-org-${sid}`;
    const pgName = `hm-org-pg-${sid}`;
    const qdName = `hm-org-qdrant-${sid}`;
    const agentName = `hm-org-agent-${sid}`;
    const pgVol = `hm-org-pgdata-${sid}`;
    const mnemeVol = `hm-org-mneme-${sid}`;
    const qdVol = `hm-org-qdrant-${sid}`;

    // Secrets — generated per org, never logged.
    const agentToken = crypto.randomBytes(32).toString('hex');
    const pgPassword = crypto.randomBytes(24).toString('hex');

    const shared = NETWORK_MODE === 'shared';
    const netName = shared ? (SHARED_NETWORK || network) : network;
    if (!shared) await ensureNetwork(network);

    // DNS names the AGENT uses to reach its own pg/qdrant over the org network.
    const pgInternalHost = pgName;
    const qdInternalHost = qdName;

    // ── postgres ────────────────────────────────────────────────────────────
    // Published on a loopback host port in hostport mode so hm-core can reach it.
    let pgHostPort = null;
    {
      const args = ['--network', netName, '--network-alias', pgInternalHost,
        '-e', `POSTGRES_USER=${POSTGRES_USER}`,
        '-e', `POSTGRES_PASSWORD=${pgPassword}`,
        '-e', `POSTGRES_DB=${POSTGRES_DB}`,
        '-v', `${pgVol}:/var/lib/postgresql/data`];
      if (!shared) {
        pgHostPort = await allocatePort();
        args.push('-p', `127.0.0.1:${pgHostPort}:5432`);
      }
      args.push(POSTGRES_IMAGE);
      await runContainer(pgName, args);
    }

    // ── qdrant ──────────────────────────────────────────────────────────────
    let qdHostPort = null;
    {
      const args = ['--network', netName, '--network-alias', qdInternalHost,
        '-v', `${qdVol}:/qdrant/storage`];
      if (!shared) {
        qdHostPort = await allocatePort();
        args.push('-p', `127.0.0.1:${qdHostPort}:6333`);
      }
      args.push(QDRANT_IMAGE);
      await runContainer(qdName, args);
    }

    // ── agent (hm-agent / .amr engine) ────────────────────────────────────────
    // DATABASE_URL/QDRANT_URL here use the INTERNAL org-network DNS names — the
    // agent talks to its own pg/qdrant over the org network, exactly like compose.
    let agentHostPort = null;
    {
      const databaseUrl = `postgresql://${POSTGRES_USER}:${pgPassword}@${pgInternalHost}:5432/${POSTGRES_DB}?schema=hivemind`;
      const args = ['--network', netName, '--network-alias', agentName,
        '-e', `ORG_ID=${orgId}`,
        '-e', `MNEME_DIM=${dim}`,
        '-e', 'MNEME_DATA_ROOT=/data/mneme',
        '-e', `DATABASE_URL=${databaseUrl}`,
        '-e', `QDRANT_URL=http://${qdInternalHost}:6333`,
        '-e', 'AGENT_PORT=8787',
        '-e', `AGENT_TOKEN=${agentToken}`,
        '-v', `${mnemeVol}:/data/mneme`];
      if (!shared) {
        agentHostPort = await allocatePort();
        args.push('-p', `127.0.0.1:${agentHostPort}:8787`);
      }
      args.push(AGENT_IMAGE);
      await runContainer(agentName, args);
    }

    // ── resolve the URLs hm-core will use to reach this org's data plane ───────
    let url, pgUrl, qdrantUrl;
    if (shared) {
      // hm-core is on the same shared network → reach containers by DNS name.
      url = `http://${agentName}:8787`;
      pgUrl = `postgresql://${POSTGRES_USER}:${pgPassword}@${pgInternalHost}:5432/${POSTGRES_DB}?schema=hivemind`;
      qdrantUrl = `http://${qdInternalHost}:6333`;
    } else {
      // hm-core reaches published loopback ports via the host gateway alias.
      url = `http://${HOST_GATEWAY}:${agentHostPort}`;
      pgUrl = `postgresql://${POSTGRES_USER}:${pgPassword}@${HOST_GATEWAY}:${pgHostPort}/${POSTGRES_DB}?schema=hivemind`;
      qdrantUrl = `http://${HOST_GATEWAY}:${qdHostPort}`;
    }

    // ── register: merge into the shared BYOD registry (same shape as
    //    /v1/selfhost/register). kind:'managed' marks it as our-cloud-hosted. ──
    let registered = false;
    try {
      const regFile = REGISTRY_FILE();
      let reg = {};
      try { reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch { /* new file */ }
      reg[orgId] = {
        url: url.replace(/\/$/, ''),
        token: agentToken,
        pgUrl,
        qdrantUrl: qdrantUrl.replace(/\/$/, ''),
        kind: 'managed',
      };
      fs.writeFileSync(regFile, JSON.stringify(reg), 'utf8');
      registered = true;
    } catch (e) {
      log('registry_write_failed', { orgId, error: e?.message });
      // Containers are up but unregistered — still report provisioned:false so the
      // caller knows routing won't activate. Don't throw.
      return { provisioned: false, error: `registry write failed: ${e?.message}`, url };
    }

    log('provisioned', { orgId, network: netName, mode: NETWORK_MODE });
    return { provisioned: true, url, registered };
  } catch (e) {
    // Top-level guard — provisioning must NEVER break org creation.
    log('provision_failed', { orgId, error: e?.message });
    return { provisioned: false, error: e?.message };
  }
}

export default { provisionManagedAgent };
