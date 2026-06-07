/**
 * Web-bridge automation relay (P1) — in-memory, long-poll, no websockets.
 *
 * Bridges a SERVER-side caller (the browser-tools MCP / agent) to a user-machine
 * CONNECTOR that proxies to the local Kimi WebBridge daemon (127.0.0.1:10086).
 *
 *   dispatch(tenant, action, args)  ── server side: enqueue a command, await result
 *        │
 *        ▼  (held in QUEUES / handed to a waiting poller)
 *   poll(tenant)                    ── connector long-polls for commands
 *        │  connector runs them against localhost:10086
 *        ▼
 *   submitResult(tenant, id, res)   ── connector returns the daemon's reply
 *        │
 *        ▼  resolves the dispatch() promise
 *
 * IMPORTANT: state is per control-plane PROCESS (in-memory). The connector and the
 * MCP must hit the SAME process — both target the PUBLIC control-plane
 * (control-plane-s0k0 / hivemind-control-plane:3000). hm-control (:3002) is separate.
 *
 * @module hermes/webbridge-relay
 */
import { randomUUID } from 'node:crypto';

const QUEUES = new Map();   // tenantId -> [{ id, action, args }]
const WAITERS = new Map();  // tenantId -> resolve([cmd,...])  (a poller parked)
const PENDING = new Map();  // commandId -> { resolve, timer, tenantId }
const LAST_SEEN = new Map(); // tenantId -> epoch ms (connector liveness)

const ONLINE_WINDOW_MS = 40000;

export function connectorSeen(tenantId) { LAST_SEEN.set(tenantId, Date.now()); }
export function isOnline(tenantId) {
  const t = LAST_SEEN.get(tenantId);
  return !!t && (Date.now() - t < ONLINE_WINDOW_MS);
}

/**
 * Server side: enqueue a browser command for a tenant and await the connector's reply.
 * @returns {Promise<object>} the daemon result, or { ok:false, error } on timeout/no-connector.
 */
export function dispatch(tenantId, action, args = {}, { timeoutMs = 60000 } = {}) {
  if (!isOnline(tenantId)) {
    return Promise.resolve({ ok: false, error: 'no browser connector paired/online for this tenant' });
  }
  const id = randomUUID();
  const cmd = { id, action, args };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { PENDING.delete(id); resolve({ ok: false, error: 'browser command timed out' }); }, timeoutMs);
    PENDING.set(id, { resolve, timer, tenantId });
    const waiter = WAITERS.get(tenantId);
    if (waiter) { WAITERS.delete(tenantId); waiter([cmd]); }
    else { const q = QUEUES.get(tenantId) || []; q.push(cmd); QUEUES.set(tenantId, q); }
  });
}

/**
 * Connector side: long-poll for the next batch of commands. Resolves immediately if
 * queued, else parks until a command arrives or the timeout elapses (then []).
 * @returns {Promise<Array<{id,action,args}>>}
 */
export function poll(tenantId, { timeoutMs = 25000 } = {}) {
  connectorSeen(tenantId);
  const q = QUEUES.get(tenantId);
  if (q && q.length) { QUEUES.delete(tenantId); return Promise.resolve(q); }
  return new Promise((resolve) => {
    const done = (cmds) => { clearTimeout(timer); if (WAITERS.get(tenantId) === done) WAITERS.delete(tenantId); resolve(cmds); };
    const timer = setTimeout(() => done([]), timeoutMs);
    WAITERS.set(tenantId, done);
  });
}

/** Connector side: deliver a command's result, resolving the waiting dispatch(). */
export function submitResult(tenantId, commandId, result) {
  connectorSeen(tenantId);
  const p = PENDING.get(commandId);
  if (!p || p.tenantId !== tenantId) return false;
  clearTimeout(p.timer);
  PENDING.delete(commandId);
  p.resolve(result);
  return true;
}
