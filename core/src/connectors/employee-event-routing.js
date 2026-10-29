/**
 * Routes approved connected-app events to OpenDot employees.
 *
 * Runs after the existing relevance approval in activity-relevance.js and never changes the Runtime path. Two targets exist:
 * an `@<employee name or slug>` mention from a sender inside the company, and an employee-owned watch whose filter matches.
 * Guards: one delivery per (event, employee), bursts for one employee coalesce into one wake, a per-hour wake cap, and no wake
 * on content a bot, an employee or Runtime produced. Every delivery or skip is recorded with its reason.
 * Off unless HIVEMIND_EMPLOYEE_EVENT_ROUTING=1. Event content is untrusted and is delivered as data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readRuntimeEnabled } from '../organizations/runtime-setting.js';
import { dispatchOpenDotEvent } from '../employees/open-dot-runtime-bridge.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Audit sentinel for a skip that belongs to the event, not to one employee. */
export const EVENT_LEVEL = '*';
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.de', 'gmx.net', 'web.de']);
const LOOP_MARKER = /hivemind_runtime_output|\[Event:[a-z0-9_-]+\]|\[Duty:[a-z]+\]/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const str = value => (typeof value === 'string' ? value : '');
const lower = value => String(value ?? '').toLowerCase();
const int = (value, fallback, min, max) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };

/**
 * Routing limits, all changeable from the environment.
 * @param {Record<string,string|undefined>} env Process environment.
 * @returns {Readonly<object>} Limits and the feature switch.
 */
export function routingConfig(env = process.env) {
  return Object.freeze({
    enabled: env.HIVEMIND_EMPLOYEE_EVENT_ROUTING === '1',
    coalesceMs: int(env.HIVEMIND_EMPLOYEE_EVENT_COALESCE_MS, 120_000, 0, 900_000),
    maxWakesPerHour: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_WAKES_PER_HOUR, 6, 1, 120),
    maxEventsPerWake: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_EVENTS_PER_WAKE, 10, 1, 25),
    mentionEmailChars: int(env.HIVEMIND_EMPLOYEE_EVENT_MENTION_EMAIL_CHARS, 2000, 200, 10_000),
    maxAttempts: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_ATTEMPTS, 5, 1, 10),
    maxWatchesPerEmployee: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_WATCHES, 20, 1, 100),
    githubAssociations: new Set(String(env.HIVEMIND_EMPLOYEE_EVENT_GITHUB_ASSOCIATIONS ?? 'OWNER,MEMBER').split(',').map(item => item.trim().toUpperCase()).filter(Boolean)),
  });
}

const names = list => (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? item : item?.name)).filter(item => typeof item === 'string');

/**
 * The plain-text facts of one event that routing reads. Only known string fields are used.
 * @param {string} toolkit Connected app slug.
 * @param {string} slug Trigger slug.
 * @param {object} data Stored event payload.
 * @param {{mentionEmailChars?:number}} [config] Limits.
 * @returns {object} Normalised facts.
 */
export function eventFacts(toolkit, slug, data = {}, config = routingConfig()) {
  const d = data && typeof data === 'object' ? data : {};
  const message = d.message && typeof d.message === 'object' ? d.message : {};
  const comment = d.comment && typeof d.comment === 'object' ? d.comment : {};
  const issue = d.issue || d.pull_request || {};
  const preview = d.preview && typeof d.preview === 'object' ? d.preview : {};
  const bodyText = [d.text, d.message_text, str(d.message), message.text, comment.body, issue.body, d.body, str(d.preview), preview.body].find(item => typeof item === 'string' && item.trim()) ?? '';
  const title = str(d.subject) || str(message.subject) || str(issue.title) || str(d.title) || str(d._hivemind?.title);
  const rawSender = [d.sender, d.from, message.from, d.user_email, d.sender_email].find(item => typeof item === 'string' && item.trim())
    ?? (typeof d.sender === 'object' && d.sender ? d.sender.email : '') ?? '';
  const login = str(d.sender?.login) || str(comment.user?.login) || str(issue.user?.login) || str(d.user?.login);
  const hivemindSender = d._hivemind?.sender && typeof d._hivemind.sender === 'object' ? d._hivemind.sender : null;
  const isEmail = toolkit === 'gmail' || toolkit === 'outlook';
  const labels = [...(Array.isArray(d.label_ids) ? d.label_ids : []).map(String), ...names(d.labels), ...names(issue.labels)].map(lower);
  const mentionText = isEmail ? `${title}\n${bodyText.slice(0, config.mentionEmailChars)}`
    : toolkit === 'github' ? `${title}\n${bodyText.slice(0, 12_000)}` : `${title && toolkit !== 'slack' ? `${title}\n` : ''}${bodyText.slice(0, 12_000)}`;
  return {
    toolkit, slug, title: clip(title, 200), body: bodyText, mentionText,
    senderRaw: clip(rawSender || login, 200),
    senderEmail: lower((EMAIL.exec(String(rawSender)) ?? [])[0] ?? ''),
    senderLogin: lower(login),
    senderId: lower(typeof d.user === 'string' ? d.user : d.user_id ?? ''),
    verifiedInternal: hivemindSender?.verified === true,
    association: str(comment.author_association || issue.author_association || d.author_association).toUpperCase(),
    labels, repository: lower(d.repository?.full_name),
    bot: Boolean(d.bot_id || d.app_id || d.subtype === 'bot_message' || d.sender?.type === 'Bot' || comment.user?.type === 'Bot' || issue.user?.type === 'Bot'),
    marked: LOOP_MARKER.test(`${title}\n${bodyText}`) || d.metadata?.event_type === 'hivemind_runtime_output' || ['runtime', 'employee'].includes(d._hivemind?.origin),
    occurredAt: d.message_timestamp ?? d.timestamp ?? d.ts ?? d.updated_at ?? null,
  };
}

/**
 * Employees mentioned as `@name` or `@slug`, case-insensitive, at a word boundary. A longer name wins over a shorter one it contains,
 * and an address such as `a@maya.com` is not a mention.
 * @param {string} text Mention text.
 * @param {{id:string,name:string,slug:string}[]} employees Routable employees.
 * @returns {string[]} Mentioned employee ids.
 */
export function mentionedEmployees(text, employees) {
  let rest = String(text ?? '');
  if (!rest.includes('@')) return [];
  const candidates = employees.flatMap(employee => [employee.name, employee.slug].filter(Boolean).map(label => ({ id: employee.id, label: String(label).trim() })))
    .filter(candidate => candidate.label).sort((a, b) => b.label.length - a.label.length);
  const found = new Set();
  for (const { id, label } of candidates) {
    const body = label.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_.+-])@${body}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'giu');
    rest = rest.replace(pattern, () => { found.add(id); return ' '; });
  }
  return [...found];
}

/**
 * Whether the sender is inside the company: an active member's email, an address on the company domain, a verified native Slack
 * sender, or (GitHub) an author association the configuration trusts. Everyone else is external.
 * @param {object} facts Event facts.
 * @param {{memberEmails:Set<string>,companyDomains:Set<string>,githubLogins?:Set<string>,slackIds?:Set<string>}} directory Company directory.
 * @param {object} config Routing limits.
 * @returns {boolean} True for an internal sender.
 */
export function internalSender(facts, directory, config = routingConfig()) {
  if (facts.verifiedInternal) return true;
  if (facts.senderEmail) {
    if (directory.memberEmails.has(facts.senderEmail)) return true;
    const domain = facts.senderEmail.split('@')[1];
    if (domain && directory.companyDomains.has(domain) && !FREE_MAIL.has(domain)) return true;
  }
  if (facts.toolkit === 'github' && (directory.githubLogins?.has(facts.senderLogin) || (facts.association && config.githubAssociations.has(facts.association)))) return true;
  if (facts.toolkit === 'slack' && facts.senderId && directory.slackIds?.has(facts.senderId)) return true;
  return false;
}

/**
 * Whether a watch matches an event. Every filter key that is set must match.
 * @param {{enabled:boolean,toolkit:string,trigger_slug:string,filter?:object}} watch The watch.
 * @param {object} facts Event facts (carries toolkit and slug).
 * @returns {boolean} True when the watch applies.
 */
export function watchMatches(watch, facts) {
  if (!watch.enabled || watch.toolkit !== facts.toolkit || watch.trigger_slug !== facts.slug) return false;
  const filter = watch.filter && typeof watch.filter === 'object' ? watch.filter : {};
  if (filter.from) {
    const needle = lower(filter.from).trim();
    if (![facts.senderEmail, facts.senderLogin, facts.senderId, lower(facts.senderRaw)].some(value => value && value.includes(needle))) return false;
  }
  if (filter.label && !facts.labels.includes(lower(filter.label).trim())) return false;
  if (filter.keyword && !lower(`${facts.title} ${facts.body}`).includes(lower(filter.keyword).trim())) return false;
  if (filter.repo && facts.repository !== lower(filter.repo).trim()) return false;
  return true;
}

/**
 * The targets of one approved event. Pure: the caller supplies the directory, the employees and the watches.
 * @param {object} input
 * @param {object} input.facts Event facts.
 * @param {string} input.orgId Organization of the event.
 * @param {string} input.eventUserId Owner of the connected account.
 * @param {string|null} input.subject Composio subject; equal to orgId for an organization-wide account.
 * @param {{id:string,name:string,slug:string,slackBotUserId?:string|null}[]} input.employees Routable employees.
 * @param {object[]} input.watches Enabled watches of the organization.
 * @param {object} input.directory Company directory, see {@link internalSender}.
 * @param {object} [input.config] Routing limits.
 * @returns {{targets:{employeeId:string,reason:string,watchIds:string[]}[],skips:{employeeId:string,reason:string}[]}} Wake targets and skip reasons.
 */
export function decideRouting({ facts, orgId, eventUserId, subject, employees, watches, directory, config = routingConfig() }) {
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const candidates = new Map();
  const skips = [];
  const add = (employeeId, reason, watchId) => {
    const entry = candidates.get(employeeId) ?? { mention: false, watchIds: [] };
    if (reason === 'mention') entry.mention = true; else entry.watchIds.push(watchId);
    candidates.set(employeeId, entry);
  };
  const external = mentionedEmployees(facts.mentionText, employees);
  const internal = internalSender(facts, directory, config);
  for (const employeeId of external) {
    if (internal) add(employeeId, 'mention'); else skips.push({ employeeId, reason: 'external_sender' });
  }
  for (const watch of watches) {
    if (watch.user_id !== eventUserId && subject !== orgId) continue;
    if (!watchMatches(watch, facts)) continue;
    if (!byId.has(watch.employee_id)) { skips.push({ employeeId: watch.employee_id, reason: 'employee_unavailable' }); continue; }
    add(watch.employee_id, 'watch', watch.id);
  }
  const botIds = new Set(employees.map(employee => lower(employee.slackBotUserId)).filter(Boolean));
  const targets = [];
  for (const [employeeId, entry] of candidates) {
    const reason = facts.bot ? 'bot_sender' : facts.marked ? 'loop_guard' : facts.senderId && botIds.has(facts.senderId) ? 'own_output' : null;
    if (reason) { skips.push({ employeeId, reason }); continue; }
    targets.push({ employeeId, reason: entry.mention && entry.watchIds.length ? 'mention+watch' : entry.mention ? 'mention' : 'watch', watchIds: entry.watchIds });
  }
  return { targets, skips };
}

/**
 * Deterministic wake id, so a retry of the same set of events reaches OpenDot as the same request.
 * @param {string} employeeId Employee.
 * @param {string[]} eventIds Event ids in the wake.
 * @returns {string} Wake id.
 */
export function wakeIdFor(employeeId, eventIds) {
  return `wk_${createHash('sha256').update(JSON.stringify([employeeId, [...eventIds].sort()])).digest('hex').slice(0, 40)}`;
}

/**
 * The fields of one event that OpenDot receives. Plain text only, bounded.
 * @param {object} facts Event facts.
 * @param {object} row Delivery row plus event row.
 * @returns {object} Event payload.
 */
export function wireEvent(facts, row) {
  return {
    eventId: row.event_id, toolkit: facts.toolkit, triggerSlug: facts.slug, reason: row.reason, ...(row.watch_id ? { watchId: row.watch_id } : {}),
    ...(row.instruction ? { instruction: clip(row.instruction, 1000) } : {}),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    title: clip(facts.title, 200), sender: clip(facts.senderRaw, 200), text: clip(facts.body, 3000),
    ...(facts.labels.length ? { labels: facts.labels.slice(0, 8) } : {}), ...(facts.repository ? { repository: facts.repository } : {}),
  };
}

// ---------- store ----------
const stores = new WeakMap();
/**
 * Creates the two tables when missing. Add-only, like ensureTriggerStore; see the release notes for the DDL that needs approval.
 * @param {{$executeRawUnsafe:Function}} db Prisma client.
 * @returns {Promise<void>} Resolves when both tables and their indexes exist.
 */
export async function ensureEmployeeEventStore(db) {
  if (!stores.has(db)) stores.set(db, (async () => {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hivemind_employee_watches (
      id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, employee_id text NOT NULL,
      toolkit text NOT NULL, trigger_slug text NOT NULL, filter jsonb NOT NULL DEFAULT '{}'::jsonb,
      instruction text NOT NULL, dedupe_key text NOT NULL, enabled boolean NOT NULL DEFAULT true,
      last_fired_at timestamptz, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(org_id, employee_id, dedupe_key))`);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS hivemind_employee_watches_lookup ON hivemind_employee_watches(org_id, toolkit, trigger_slug) WHERE enabled');
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hivemind_employee_event_deliveries (
      id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, employee_id text NOT NULL, event_id text NOT NULL,
      toolkit text NOT NULL, trigger_slug text NOT NULL, reason text NOT NULL, watch_id uuid,
      status text NOT NULL, skip_reason text, wake_id text, summary text, attempts integer NOT NULL DEFAULT 0, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, delivered_at timestamptz,
      UNIQUE(event_id, employee_id))`);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS hivemind_employee_event_deliveries_employee ON hivemind_employee_event_deliveries(org_id, employee_id, created_at DESC)');
    await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS hivemind_employee_event_deliveries_open ON hivemind_employee_event_deliveries(status, created_at) WHERE status IN ('pending','sending')");
  })().catch(error => { stores.delete(db); throw error; }));
  return stores.get(db);
}

const boundMarker = employee => {
  const marker = employee.policyRules?.open_dot_employee, lifecycle = employee.policyRules?.native_lifecycle;
  return marker?.version === 1 && marker.execution_backend === 'open-dot' && marker.state === 'bound' && /^dot_[a-zA-Z0-9_-]+$/.test(marker.dot_id || '')
    && lifecycle?.version === 1 && lifecycle.phase === 'active' ? marker.dot_id : null;
};

/**
 * Employees the account owner may route to: active, bound to an OpenDot employee, and visible to that user.
 * @param {object} db Prisma client.
 * @param {string} orgId Organization.
 * @param {string} userId Account owner.
 * @returns {Promise<{id:string,name:string,slug:string,dotId:string,tenantUserId:string,slackBotUserId:string|null}[]>} Routable employees.
 */
export async function loadRoutableEmployees(db, orgId, userId) {
  const membership = await db.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, isActive: true, deactivatedAt: true } });
  if (!membership?.isActive || membership.deactivatedAt) return [];
  const rows = await db.digitalEmployee.findMany({ where: { orgId, archivedAt: null }, select: { id: true, name: true, slug: true, createdBy: true, teamId: true, scope: true, status: true, policyRules: true, slackBotUserId: true } });
  const admin = ['owner', 'admin'].includes(membership.role);
  const teams = admin ? [] : (await db.teamMember.findMany({ where: { userId, team: { orgId } }, select: { teamId: true } })).map(row => row.teamId);
  return rows.filter(employee => employee.status !== 'paused' && (admin || employee.createdBy === userId || employee.scope === 'organization' || (employee.scope === 'team' && teams.includes(employee.teamId))))
    .flatMap(employee => { const dotId = boundMarker(employee); return dotId ? [{ id: employee.id, name: employee.name, slug: employee.slug, dotId, tenantUserId: employee.createdBy || userId, slackBotUserId: employee.slackBotUserId ?? null }] : []; });
}

/**
 * Who counts as inside the company: active members' emails and the company email domains from the organization profile.
 * @param {object} db Prisma client.
 * @param {string} orgId Organization.
 * @returns {Promise<{memberEmails:Set<string>,companyDomains:Set<string>}>} Directory.
 */
export async function loadCompanyDirectory(db, orgId) {
  const [members, org] = await Promise.all([
    db.userOrganization.findMany({ where: { orgId, isActive: true, deactivatedAt: null }, select: { user: { select: { email: true, deletedAt: true } } } }),
    db.organization.findUnique({ where: { id: orgId }, select: { companyProfile: true } }),
  ]);
  const profile = org?.companyProfile && typeof org.companyProfile === 'object' ? org.companyProfile : {};
  const raw = [profile.email_domains, profile.email_domain, profile.domain, profile.website].flat().filter(item => typeof item === 'string');
  const domain = item => lower(item).replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/^.*@/, '').split(/[/?#:]/)[0].trim();
  return {
    memberEmails: new Set(members.filter(row => row.user && !row.user.deletedAt).map(row => lower(row.user.email))),
    companyDomains: new Set(raw.flatMap(item => item.split(',')).map(domain).filter(item => item.includes('.') && !FREE_MAIL.has(item))),
  };
}

async function recordDelivery(db, row) {
  return db.$queryRawUnsafe(`INSERT INTO hivemind_employee_event_deliveries
    (id,org_id,user_id,employee_id,event_id,toolkit,trigger_slug,reason,watch_id,status,skip_reason,summary)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12) ON CONFLICT(event_id,employee_id) DO NOTHING RETURNING id`,
  randomUUID(), row.orgId, row.userId, row.employeeId, row.eventId, row.toolkit, row.slug, row.reason, row.watchId ?? null, row.status, row.skipReason ?? null, row.summary ?? null);
}

const timers = new Set();
function scheduleFlush(db, key, delay, deps) {
  if (timers.has(key)) return;
  timers.add(key);
  const timer = setTimeout(() => { timers.delete(key); flushEmployeeWakes(db, deps).catch(() => {}); }, delay);
  timer.unref?.();
}

/**
 * Routing step for one approved event. Never throws and never touches the Runtime path.
 * @param {object} db Prisma client.
 * @param {{orgId:string,userId:string,event:{id:string,data:object,occurred_at?:string},sub:{toolkit:string,slug?:string,subject?:string}}} input Event and its subscription.
 * @param {object} [deps] Test hooks: config, runtimeEnabled, deliver, schedule.
 * @returns {Promise<object>} What was recorded.
 */
export async function routeApprovedEvent(db, { orgId, userId, event, sub }, deps = {}) {
  const config = deps.config ?? routingConfig();
  if (!config.enabled) return { skipped: 'routing_disabled' };
  if (!UUID.test(orgId || '') || !UUID.test(userId || '') || !sub?.slug) return { skipped: 'scope_unavailable' };
  await ensureEmployeeEventStore(db);
  const facts = eventFacts(sub.toolkit, sub.slug, event.data, config);
  const watches = await db.$queryRawUnsafe('SELECT * FROM hivemind_employee_watches WHERE org_id=$1 AND toolkit=$2 AND trigger_slug=$3 AND enabled', orgId, sub.toolkit, sub.slug);
  const runtimeEnabled = deps.runtimeEnabled ?? await readRuntimeEnabled(db, orgId);
  const base = { orgId, userId, eventId: event.id, toolkit: sub.toolkit, slug: sub.slug, summary: clip(facts.title || facts.body, 140) };
  if (!watches.length && !facts.mentionText.includes('@')) {
    // Runtime on: today's path is the whole story. Runtime off: nobody reads this event, so say so in the audit.
    if (!runtimeEnabled) await recordDelivery(db, { ...base, employeeId: EVENT_LEVEL, reason: 'none', status: 'skipped', skipReason: 'no_target_runtime_off' });
    return { targets: [], skips: [] };
  }
  const [employees, directory] = await Promise.all([loadRoutableEmployees(db, orgId, userId), loadCompanyDirectory(db, orgId)]);
  const decision = decideRouting({ facts, orgId, eventUserId: userId, subject: sub.subject ?? null, employees, watches, directory, config });
  for (const skip of decision.skips) await recordDelivery(db, { ...base, employeeId: skip.employeeId, reason: 'candidate', status: 'skipped', skipReason: skip.reason });
  if (!decision.targets.length && !decision.skips.length && !runtimeEnabled) await recordDelivery(db, { ...base, employeeId: EVENT_LEVEL, reason: 'none', status: 'skipped', skipReason: 'no_target_runtime_off' });
  for (const target of decision.targets) {
    await recordDelivery(db, { ...base, employeeId: target.employeeId, reason: target.reason, watchId: target.watchIds[0], status: 'pending' });
    (deps.schedule ?? (() => scheduleFlush(db, `${orgId}:${target.employeeId}`, config.coalesceMs + 500, deps)))(target);
  }
  return decision;
}

const permanent = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;

/**
 * Sends every due batch: the pending rows of one employee whose oldest row is at least the coalescing window old become one wake.
 * An employee over the hourly cap gets its events marked for the next brief instead.
 * @param {object} db Prisma client.
 * @param {object} [deps] Test hooks: config, now, deliver.
 * @returns {Promise<{wakes:number,briefed:number,skipped:number,failed:number}>} Counts for this sweep.
 */
export async function flushEmployeeWakes(db, deps = {}) {
  const config = deps.config ?? routingConfig();
  const totals = { wakes: 0, briefed: 0, skipped: 0, failed: 0 };
  if (!config.enabled) return totals;
  await ensureEmployeeEventStore(db);
  const now = deps.now ? new Date(deps.now) : new Date();
  const due = await db.$queryRawUnsafe(`SELECT org_id,employee_id FROM hivemind_employee_event_deliveries
    WHERE employee_id<>$3 AND (status='pending' OR (status='sending' AND claimed_at < $2::timestamptz))
    GROUP BY org_id,employee_id HAVING min(created_at) <= $1::timestamptz ORDER BY min(created_at) LIMIT 32`,
  new Date(now.getTime() - config.coalesceMs).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), EVENT_LEVEL);
  for (const { org_id: orgId, employee_id: employeeId } of due) {
    try { const part = await flushEmployee(db, orgId, employeeId, now, config, deps); for (const key of Object.keys(totals)) totals[key] += part[key] ?? 0; }
    catch { totals.failed += 1; }
  }
  return totals;
}

async function flushEmployee(db, orgId, employeeId, now, config, deps) {
  const out = { wakes: 0, briefed: 0, skipped: 0, failed: 0 };
  const rows = await db.$queryRawUnsafe(`UPDATE hivemind_employee_event_deliveries SET status='sending',claimed_at=now(),attempts=attempts+1
    WHERE id IN (SELECT id FROM hivemind_employee_event_deliveries WHERE org_id=$1 AND employee_id=$2 AND created_at <= $3::timestamptz
      AND (status='pending' OR (status='sending' AND claimed_at < $4::timestamptz)) ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING *`,
  orgId, employeeId, now.toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString());
  if (!rows.length) return out;
  const finish = (ids, status, reason, error) => db.$executeRawUnsafe(
    `UPDATE hivemind_employee_event_deliveries SET status=$2,skip_reason=$3,last_error=$4,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END WHERE id = ANY($1::uuid[])`,
    ids, status, reason ?? null, error ?? null);
  const watchOutcome = (ids, error) => ids.length ? db.$executeRawUnsafe(
    error ? 'UPDATE hivemind_employee_watches SET last_error=$2,updated_at=now() WHERE id = ANY($1::uuid[])' : 'UPDATE hivemind_employee_watches SET last_fired_at=now(),last_error=NULL,updated_at=now() WHERE id = ANY($1::uuid[])',
    ...(error ? [ids, error] : [ids])) : undefined;
  const watchIds = [...new Set(rows.map(row => row.watch_id).filter(Boolean))];
  const allIds = rows.map(row => row.id);
  const employees = await loadRoutableEmployees(db, orgId, rows[0].user_id);
  const employee = employees.find(item => item.id === employeeId);
  if (!employee) { await finish(allIds, 'skipped', 'employee_unavailable'); await watchOutcome(watchIds, 'employee_unavailable'); out.skipped += rows.length; return out; }
  const recent = await db.$queryRawUnsafe(`SELECT count(DISTINCT wake_id)::int AS wakes FROM hivemind_employee_event_deliveries
    WHERE org_id=$1 AND employee_id=$2 AND status='delivered' AND delivered_at > $3::timestamptz`, orgId, employeeId, new Date(now.getTime() - 3_600_000).toISOString());
  if ((recent[0]?.wakes ?? 0) >= config.maxWakesPerHour) { await finish(allIds, 'briefed', 'rate_limited'); out.briefed += rows.length; return out; }
  const kept = rows.slice(0, config.maxEventsPerWake), overflow = rows.slice(config.maxEventsPerWake);
  if (overflow.length) { await finish(overflow.map(row => row.id), 'briefed', 'wake_event_cap'); out.briefed += overflow.length; }
  const events = await db.$queryRawUnsafe('SELECT id,data,occurred_at FROM hivemind_trigger_events WHERE id = ANY($1::text[]) AND org_id=$2', kept.map(row => row.event_id), orgId);
  const instructions = new Map((kept.some(row => row.watch_id) ? await db.$queryRawUnsafe('SELECT id,instruction FROM hivemind_employee_watches WHERE id = ANY($1::uuid[])', kept.map(row => row.watch_id).filter(Boolean)) : []).map(row => [row.id, row.instruction]));
  const wire = kept.flatMap(row => {
    const event = events.find(item => item.id === row.event_id);
    return event ? [wireEvent(eventFacts(row.toolkit, row.trigger_slug, event.data, config), { ...row, occurred_at: event.occurred_at, instruction: instructions.get(row.watch_id) })] : [];
  });
  const keptIds = kept.map(row => row.id);
  if (!wire.length) { await finish(keptIds, 'skipped', 'event_unavailable'); out.skipped += kept.length; return out; }
  const wakeId = wakeIdFor(employeeId, kept.map(row => row.event_id));
  await db.$executeRawUnsafe('UPDATE hivemind_employee_event_deliveries SET wake_id=$2 WHERE id = ANY($1::uuid[])', keptIds, wakeId);
  const kitWatchIds = [...new Set(kept.map(row => row.watch_id).filter(Boolean))];
  try {
    await (deps.deliver ?? dispatchOpenDotEvent)({ version: 1, organizationId: orgId, userId: employee.tenantUserId, employeeId, dotId: employee.dotId, wakeId, events: wire, ...(overflow.length ? { omitted: overflow.length } : {}) });
    await finish(keptIds, 'delivered');
    await watchOutcome(kitWatchIds);
    out.wakes += 1;
  } catch (error) {
    const code = clip(error?.message, 120) || 'delivery_failed';
    await watchOutcome(kitWatchIds, code);
    if (permanent(error)) { await finish(keptIds, 'skipped', code, code); out.skipped += kept.length; }
    else if (Math.max(...kept.map(row => row.attempts)) >= config.maxAttempts) { await finish(keptIds, 'failed', 'delivery_failed', code); out.failed += kept.length; }
    else await db.$executeRawUnsafe("UPDATE hivemind_employee_event_deliveries SET status='pending',last_error=$2 WHERE id = ANY($1::uuid[])", keptIds, code);
  }
  return out;
}
