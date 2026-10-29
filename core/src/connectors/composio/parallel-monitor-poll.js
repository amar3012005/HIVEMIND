/**
 * Parallel monitor events into Runtime attention.
 *
 * Composio has no trigger type for the `parallel` toolkit, and Parallel's
 * CreateMonitor webhook accepts only a URL and event types (no signing secret),
 * so a webhook could not be authenticated. This job instead polls
 * PARALLEL_LIST_MONITORS / PARALLEL_LIST_MONITOR_EVENTS for every company with
 * an ACTIVE parallel account and writes each new event as a
 * `hivemind_trigger_events` row, the same ledger Gmail trigger events use, so
 * the existing classifier delivers it to Runtime. Event ids are deterministic,
 * so a repeated poll never writes an event twice.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ensureTriggerStore } from './hivemind-triggers.js';
import { classifyPendingActivity } from './activity-relevance.js';
import { listActiveToolkitAccounts, executeTool } from './composio-service.js';

export const PARALLEL_TRIGGER_SLUG = 'PARALLEL_MONITOR_EVENTS';
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/**
 * Validate the poll configuration. Unset or "0" disables the job; anything else must be valid.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {null | { intervalMs: number, maxAccounts: number, maxMonitors: number, maxEventsPerMonitor: number, lookbackDays: number }}
 * @throws {Error} on a value outside its range, so a bad deployment setting is visible at startup
 */
export function parallelPollConfig(env = process.env) {
  const raw = env.PARALLEL_MONITOR_POLL_INTERVAL_MS;
  if (raw === undefined || raw === '' || raw === '0') return null;
  const number = (name, value, min, max, fallback) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
  };
  return {
    intervalMs: number('PARALLEL_MONITOR_POLL_INTERVAL_MS', raw, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 0),
    maxAccounts: number('PARALLEL_MONITOR_POLL_MAX_ACCOUNTS', env.PARALLEL_MONITOR_POLL_MAX_ACCOUNTS, 1, 200, 25),
    maxMonitors: number('PARALLEL_MONITOR_POLL_MAX_MONITORS', env.PARALLEL_MONITOR_POLL_MAX_MONITORS, 1, 100, 20),
    maxEventsPerMonitor: number('PARALLEL_MONITOR_POLL_MAX_EVENTS', env.PARALLEL_MONITOR_POLL_MAX_EVENTS, 1, 100, 10),
    lookbackDays: number('PARALLEL_MONITOR_POLL_LOOKBACK_DAYS', env.PARALLEL_MONITOR_POLL_LOOKBACK_DAYS, 1, 14, 2),
  };
}

function firstArray(data, keys) {
  if (Array.isArray(data)) return data;
  const body = record(data);
  if (!body) return [];
  for (const key of keys) if (Array.isArray(body[key])) return body[key];
  return firstArray(record(body.data) ? body.data : null, keys);
}

/** Monitors from a PARALLEL_LIST_MONITORS result: id, query and status, tolerant of field naming. */
export function normalizeMonitors(data) {
  return firstArray(data, ['monitors', 'items', 'results']).map((item) => {
    const m = record(item); if (!m) return null;
    const id = clip(m.monitor_id ?? m.id, 120);
    if (!id) return null;
    return { id, query: clip(m.query ?? m.name ?? m.description, 500), status: clip(m.status, 40).toLowerCase() };
  }).filter((m) => m && !/^(?:canceled|cancelled|deleted|inactive|paused)$/.test(m.status));
}

/** Events from a PARALLEL_LIST_MONITOR_EVENTS result: id, time, change summary and bounded detail. */
export function normalizeMonitorEvents(data) {
  return firstArray(data, ['events', 'items', 'results']).map((item) => {
    const e = record(item); if (!e) return null;
    const output = record(e.result) ?? record(e.output) ?? {};
    const summary = clip(e.summary ?? e.message ?? e.description ?? output.summary ?? output.message
      ?? (typeof e.output === 'string' ? e.output : '') ?? '', 1200);
    const when = e.event_date ?? e.created_at ?? e.timestamp ?? e.occurred_at ?? e.date;
    const parsed = typeof when === 'string' || typeof when === 'number' ? new Date(when) : null;
    const occurredAt = parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    const id = clip(e.event_group_id ?? e.event_id ?? e.id, 160)
      || (summary ? `h:${createHash('sha256').update(`${occurredAt || ''}|${summary}`).digest('hex').slice(0, 32)}` : '');
    if (!id || !summary) return null;
    return { id, occurredAt, summary, detail: clip(JSON.stringify(e), 2000) };
  }).filter(Boolean);
}

/** Deterministic ledger id for one monitor event of one owner; a repeated poll maps to the same row. */
export function parallelEventId(orgId, userId, monitorId, eventId) {
  return `parallel:${createHash('sha256').update(JSON.stringify([orgId, userId, monitorId, eventId])).digest('hex')}`;
}

/** Companies an account's subject acts for: personal subjects map to the user's owner/admin orgs, an org subject to its owner. */
export async function ownersOfSubject(prisma, subject) {
  const admin = { isActive: true, deactivatedAt: null, role: { in: ['owner', 'admin'] } };
  if (subject.startsWith('hivemind:')) {
    const userId = subject.slice('hivemind:'.length);
    const rows = await prisma.userOrganization.findMany({ where: { userId, ...admin }, select: { orgId: true, userId: true }, take: 3 });
    return rows.map((row) => ({ orgId: row.orgId, userId: row.userId }));
  }
  if (subject.includes(':')) {
    const [orgId, userId] = subject.split(':');
    const row = await prisma.userOrganization.findFirst({ where: { orgId, userId, ...admin }, select: { orgId: true, userId: true } });
    return row ? [{ orgId: row.orgId, userId: row.userId }] : [];
  }
  const row = await prisma.userOrganization.findFirst({ where: { orgId: subject, isActive: true, deactivatedAt: null, role: 'owner' }, select: { orgId: true, userId: true }, orderBy: { invitedAt: 'asc' } });
  return row ? [{ orgId: row.orgId, userId: row.userId }] : [];
}

/** The attention subscription for one owner's parallel account; null when the person paused, deleted or opted out of it. */
async function parallelSubscription(db, owner, account) {
  const rows = await db.$queryRawUnsafe(`INSERT INTO hivemind_trigger_subscriptions
    (id,org_id,user_id,account_id,toolkit,slug,config,config_schema,payload_schema,version,config_key,subject,remote_id,status,runtime_attention,runtime_attention_revision,runtime_attention_enabled_at)
    VALUES ($1::uuid,$2,$3,$4,'parallel',$5,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'poll-v1','poll',$6,$7,'active',true,1,now())
    ON CONFLICT(org_id,user_id,account_id,slug,config_key) DO UPDATE SET updated_at=now()
    RETURNING *, (xmax = 0) AS inserted`, randomUUID(), owner.orgId, owner.userId, account.id, PARALLEL_TRIGGER_SLUG,
    account.subject, `parallel-poll:${account.id}`);
  const row = rows[0];
  return row && row.status === 'active' && row.runtime_attention_opt_out !== true ? row : null;
}

/**
 * One bounded poll over every company with an ACTIVE parallel account.
 *
 * @param {object} deps
 * @param {object} deps.prisma Prisma client
 * @param {NonNullable<ReturnType<typeof parallelPollConfig>>} deps.config validated limits
 * @param {() => Promise<Array<{ id: string, subject: string }>>} [deps.listAccounts]
 * @param {(subject: string, slug: string, args: object) => Promise<{ successful: boolean, data: any }>} [deps.run] Composio execution under a subject
 * @param {(ctx: object) => any} [deps.classify]
 * @param {number} [deps.offset] rotating start so no account is starved when more exist than `maxAccounts`
 * @returns {Promise<{ accounts: number, written: number, nextOffset: number }>}
 */
export async function pollParallelMonitors({ prisma, config, listAccounts = () => listActiveToolkitAccounts('parallel'),
  run = (subject, slug, args) => executeTool('', slug, args, { subject }), classify = classifyPendingActivity, offset = 0 }) {
  await ensureTriggerStore(prisma);
  const all = (await listAccounts()).sort((a, b) => a.id.localeCompare(b.id));
  const start = all.length ? offset % all.length : 0;
  const batch = [...all.slice(start), ...all.slice(0, start)].slice(0, config.maxAccounts);
  let written = 0;
  for (const account of batch) {
    let owners;
    try { owners = await ownersOfSubject(prisma, account.subject); } catch { continue; }
    let monitors;
    try {
      const listed = await run(account.subject, 'PARALLEL_LIST_MONITORS', { limit: String(config.maxMonitors) });
      if (!listed?.successful) continue;
      monitors = normalizeMonitors(listed.data).slice(0, config.maxMonitors);
    } catch { continue; }
    const fetched = [];
    for (const monitor of monitors) {
      try {
        const result = await run(account.subject, 'PARALLEL_LIST_MONITOR_EVENTS', { monitor_id: monitor.id, lookback_period: `${config.lookbackDays}d` });
        if (result?.successful) fetched.push({ monitor, events: normalizeMonitorEvents(result.data).slice(0, config.maxEventsPerMonitor) });
      } catch { /* the next tick retries this monitor; other monitors are independent */ }
    }
    for (const owner of owners) {
      const sub = await parallelSubscription(prisma, owner, account);
      if (!sub) continue;
      const since = new Date(sub.created_at).getTime();
      for (const { monitor, events } of fetched) {
        for (const event of events) {
          // A newly connected account must not replay history into Runtime's attention.
          if (!event.occurredAt || new Date(event.occurredAt).getTime() < since) continue;
          const id = parallelEventId(owner.orgId, owner.userId, monitor.id, event.id);
          const data = { source: 'parallel', monitor_id: monitor.id, query: monitor.query, summary: event.summary,
            title: monitor.query || `Parallel monitor ${monitor.id}`, preview: event.summary, event_id: event.id, detail: event.detail };
          const inserted = await prisma.$queryRawUnsafe(`INSERT INTO hivemind_trigger_events (id,subscription_id,org_id,user_id,data,occurred_at)
            VALUES ($1,$2::uuid,$3,$4,$5::jsonb,$6::timestamptz) ON CONFLICT(id) DO NOTHING RETURNING id`,
            id, sub.id, owner.orgId, owner.userId, JSON.stringify(data), event.occurredAt);
          if (inserted.length) written += 1;
        }
      }
      if (written) classify({ orgId: owner.orgId, userId: owner.userId, prisma, allowedAccountIds: [account.id] });
    }
  }
  return { accounts: batch.length, written, nextOffset: start + batch.length };
}

/**
 * Start the recurring poll. Returns a stop function, or null when disabled.
 *
 * @param {{ prisma: object, env?: Record<string, string|undefined>, log?: Pick<Console, 'warn'|'log'>, poll?: typeof pollParallelMonitors }} options
 * @throws {Error} when the environment configuration is invalid
 */
export function startParallelMonitorPoller({ prisma, env = process.env, log = console, poll = pollParallelMonitors }) {
  const config = parallelPollConfig(env);
  if (!config) return null;
  let running = false; let offset = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try { offset = (await poll({ prisma, config, offset })).nextOffset; }
    catch (error) { log.warn('[parallel-monitors] poll failed:', error?.status || error?.message); }
    finally { running = false; }
  };
  const first = setTimeout(tick, 30_000); first.unref();
  const timer = setInterval(tick, config.intervalMs); timer.unref();
  log.log(`[parallel-monitors] polling every ${config.intervalMs} ms`);
  return () => { clearTimeout(first); clearInterval(timer); };
}
