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
/** Hosts anyone can publish on: an address there proves nothing about the company, so none of them can be the company domain. */
const SHARED_HOSTING = ['github.io', 'githubusercontent.com', 'vercel.app', 'netlify.app', 'calendly.com', 'notion.site', 'notion.so', 'wixsite.com', 'wix.com', 'webflow.io', 'herokuapp.com', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'blogspot.com', 'wordpress.com', 'squarespace.com', 'carrd.co', 'framer.app', 'framer.website', 'ghost.io', 'substack.com', 'medium.com', 'linktr.ee', 'typeform.com', 'hubspot.com', 'mailchimpsites.com', 'surge.sh', 'render.com', 'onrender.com', 'fly.dev', 'railway.app', 'repl.co', 'glitch.me', 'bubbleapps.io', 'airtable.com', 'google.com', 'sites.google.com', 'canva.site', 'my.canva.site', 'carrd.co', 'godaddysites.com', 'weebly.com', 'myshopify.com', 'zoom.us', 'slack.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com'];
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'co.za', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'co.kr', 'com.ar']);
const LOOP_MARKER = /hivemind_runtime_output|\[Event:[a-z0-9_-]+\]|\[Duty:[a-z]+\]/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
/**
 * The registrable domain of a host: the last two labels, or three under a known two-part suffix such as co.uk.
 * @param {string} host A host name.
 * @returns {string} Lower-case registrable domain, or '' for a single label.
 */
export function registrableDomain(host) {
  const labels = lower(host).replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const tail2 = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(tail2) && labels.length >= 3 ? labels.slice(-3).join('.') : tail2;
}
/** True for a free mail or shared hosting domain, which can never be the company's. */
export const untrustedDomain = domain => FREE_MAIL.has(domain) || SHARED_HOSTING.some(entry => domain === entry || domain.endsWith(`.${entry}`));

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
    routeTimeoutMs: int(env.HIVEMIND_EMPLOYEE_EVENT_ROUTE_TIMEOUT_MS, 2000, 100, 30_000),
    maxWakeAgeMs: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_WAKE_AGE_MS, 7_200_000, 60_000, 86_400_000),
    maxWatchesPerEmployee: int(env.HIVEMIND_EMPLOYEE_EVENT_MAX_WATCHES, 20, 1, 100),
    // GitHub has no link between a login and a company member, so a GitHub author counts as inside only when GitHub itself calls
    // them OWNER or MEMBER of an organization this company lists here. Empty by default: GitHub mentions then never wake anyone.
    githubOrgs: new Set(String(env.HIVEMIND_EMPLOYEE_EVENT_GITHUB_ORGS ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)),
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
  const hivemindSender = d._hivemind?.sender && typeof d._hivemind.sender === 'object' ? d._hivemind.sender : null;
  const isEmail = toolkit === 'gmail' || toolkit === 'outlook';
  const labels = [...(Array.isArray(d.label_ids) ? d.label_ids : []).map(String), ...names(d.labels), ...names(issue.labels)].map(lower);
  // GitHub: the text a person wrote is the comment, or for an issue or pull request event the issue itself; its author is the identity that counts.
  const hasComment = typeof comment.body === 'string' && comment.body.trim() !== '';
  const author = hasComment ? comment : issue;
  const login = lower(str(author.user?.login) || (hasComment || issue.user ? '' : str(d.sender?.login) || str(d.user?.login)));
  const address = isEmail ? parseAddress(rawSender) : '';
  const evidence = isEmail ? senderEvidence(d, message, address) : { verified: false };
  let mentionText;
  if (isEmail) {
    // Only what the verified sender typed: the new body without quoted replies, and the subject only when the sender began the thread.
    const replied = /^\s*(re|fwd?|aw|sv|wg|tr)\s*:/iu.test(title) || Boolean(d['in-reply-to'] ?? d.in_reply_to ?? message.in_reply_to ?? headerValue(d, message, 'in-reply-to') ?? headerValue(d, message, 'references'));
    mentionText = `${replied ? '' : `${title}\n`}${stripQuoted(bodyText).slice(0, config.mentionEmailChars)}`;
  } else if (toolkit === 'github') {
    mentionText = hasComment ? comment.body.slice(0, 12_000) : `${str(issue.title)}\n${str(issue.body)}`.slice(0, 12_000);
  } else mentionText = bodyText.slice(0, 12_000);
  return {
    toolkit, slug, title: clip(title, 200), body: bodyText, mentionText,
    senderRaw: clip(isEmail ? (address || rawSender) : rawSender || login, 200),
    senderEmail: address,
    senderEmailVerified: evidence.verified,
    senderLogin: login,
    senderId: lower(typeof d.user === 'string' ? d.user : d.user_id ?? ''),
    verifiedInternal: hivemindSender?.verified === true,
    association: str(author.author_association || d.author_association).toUpperCase(),
    labels, repository: lower(d.repository?.full_name), repoOwner: lower(d.repository?.owner?.login ?? String(d.repository?.full_name ?? '').split('/')[0]),
    bot: Boolean(d.bot_id || d.app_id || d.subtype === 'bot_message' || d.sender?.type === 'Bot' || comment.user?.type === 'Bot' || issue.user?.type === 'Bot'),
    marked: LOOP_MARKER.test(`${title}\n${bodyText}`) || d.metadata?.event_type === 'hivemind_runtime_output' || ['runtime', 'employee'].includes(d._hivemind?.origin),
    occurredAt: d.message_timestamp ?? d.timestamp ?? d.ts ?? d.updated_at ?? null,
  };
}

/**
 * The sender address of a From value, taken only from the address itself: the angle-bracket form at the end, else a bare address.
 * A display name, which the sender controls, is never read.
 * @param {string} raw From header value.
 * @returns {string} Lower-case address, or '' when none can be read.
 */
export function parseAddress(raw) {
  const value = String(raw ?? '').trim();
  const angle = /<\s*([^<>\s,;"]+@[^<>\s,;"]+)\s*>\s*$/u.exec(value);
  if (angle) return lower(angle[1]);
  return /^[^<>\s,;"]+@[^<>\s,;"]+$/u.test(value) ? lower(value) : '';
}

/** The new text of a message: quoted lines, "On ... wrote:" and forwarded or original-message blocks and everything after them are removed. */
export function stripQuoted(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (/^\s*(on .{3,200} wrote:|-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,}|from:\s.+@.+|de :\s.+@.+)\s*$/iu.test(line)) break;
    if (/^\s*>/u.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function headerValue(d, message, name) {
  const lists = [d.headers, d.payload?.headers, message.headers, message.payload?.headers];
  for (const list of lists) {
    if (Array.isArray(list)) { const found = list.find(item => lower(item?.name) === name); if (found && typeof found.value === 'string') return found.value; }
    else if (list && typeof list === 'object') { const key = Object.keys(list).find(item => lower(item) === name); if (key && typeof list[key] === 'string') return list[key]; }
  }
  return undefined;
}

/**
 * Whether the event proves the sender address: explicit sender-verification metadata from the connector, or an Authentication-Results
 * (else ARC-Authentication-Results) header with a DMARC pass for that domain, or SPF and DKIM both passing for that domain.
 * @returns {{verified:boolean}} The verdict.
 */
function senderEvidence(d, message, address) {
  const domain = address.split('@')[1];
  if (!domain) return { verified: false };
  if (d.sender_verified === true || message.sender_verified === true) return { verified: true };
  const header = headerValue(d, message, 'authentication-results') ?? headerValue(d, message, 'arc-authentication-results') ?? str(d.authentication_results);
  if (!header) return { verified: false };
  // Relaxed alignment, as DMARC defines it: the authenticated domain and the sender share a registrable domain.
  const aligned = other => { const o = lower(other).replace(/[>;\s]+$/u, ''); return o !== '' && registrableDomain(o) === registrableDomain(domain); };
  const prop = (key) => [...header.matchAll(new RegExp(`${key}\\s*=\\s*([^\\s;]+)`, 'giu'))].map(match => match[1]);
  const dmarc = /dmarc\s*=\s*pass/iu.test(header) && prop('header\\.from').some(aligned);
  const spf = /spf\s*=\s*pass/iu.test(header) && [...prop('smtp\\.mailfrom'), ...prop('smtp\\.helo')].some(value => aligned(value.split('@').pop()));
  const dkim = /dkim\s*=\s*pass/iu.test(header) && prop('header\\.(?:d|i)').some(value => aligned(value.split('@').pop()));
  return { verified: dmarc || (spf && dkim) };
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
 * How the sender relates to the company: "internal", "unverified" (a company address with no proof the domain sent it) or "external". Inside means: an active member's email, an address on the company domain, a verified native Slack
 * sender, or (GitHub) an author association the configuration trusts. Everyone else is external.
 * @param {object} facts Event facts.
 * @param {{memberEmails:Set<string>,companyDomains:Set<string>,githubLogins?:Set<string>,slackIds?:Set<string>}} directory Company directory.
 * @param {object} config Routing limits.
 * @returns {boolean} True for an internal sender.
 */
export function senderStatus(facts, directory, config = routingConfig()) {
  if (facts.verifiedInternal) return 'internal';
  if (facts.senderEmail) {
    const domain = facts.senderEmail.split('@')[1] ?? '';
    const known = directory.memberEmails.has(facts.senderEmail)
      || (domain && !untrustedDomain(domain) && directory.companyDomains.has(registrableDomain(domain)));
    // An address alone proves nothing: the message must carry evidence that its domain sent it.
    if (known) return facts.senderEmailVerified ? 'internal' : 'unverified';
  }
  if (facts.toolkit === 'github' && (directory.githubLogins?.has(facts.senderLogin) || (['OWNER', 'MEMBER'].includes(facts.association) && config.githubOrgs.has(facts.repoOwner)))) return 'internal';
  if (facts.toolkit === 'slack' && facts.senderId && directory.slackIds?.has(facts.senderId)) return 'internal';
  return 'external';
}

/** True when {@link senderStatus} is "internal". */
export const internalSender = (facts, directory, config = routingConfig()) => senderStatus(facts, directory, config) === 'internal';

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
  const status = senderStatus(facts, directory, config);
  for (const employeeId of external) {
    if (status === 'internal') add(employeeId, 'mention'); else skips.push({ employeeId, reason: status === 'unverified' ? 'unverified_sender' : 'external_sender' });
  }
  for (const watch of watches) {
    if (watch.user_id !== eventUserId && subject !== orgId) continue;
    if (!watchMatches(watch, facts)) continue;
    if (!byId.has(watch.employee_id)) { skips.push({ employeeId: watch.employee_id, reason: 'employee_unavailable' }); continue; }
    add(watch.employee_id, 'watch', watch.id);
  }
  // The wake lands in the chat of the user who owns the employee's Dot. Another user's mailbox content only goes there for an organization-wide account.
  const foreign = new Set(employees.filter(employee => employee.tenantUserId !== eventUserId && subject !== orgId).map(employee => employee.id));
  const botIds = new Set(employees.map(employee => lower(employee.slackBotUserId)).filter(Boolean));
  const targets = [];
  for (const [employeeId, entry] of candidates) {
    const reason = foreign.has(employeeId) ? 'other_owner' : facts.bot ? 'bot_sender' : facts.marked ? 'loop_guard' : facts.senderId && botIds.has(facts.senderId) ? 'own_output' : null;
    if (reason) { skips.push({ employeeId, reason }); continue; }
    targets.push({ employeeId, reason: entry.mention && entry.watchIds.length ? 'mention+watch' : entry.mention ? 'mention' : 'watch', watchIds: entry.watchIds });
  }
  // A skip for one reason never hides a valid wake for the same employee, such as a watch on the same event.
  const woken = new Set(targets.map(target => target.employeeId));
  return { targets, skips: skips.filter(skip => !woken.has(skip.employeeId)) };
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
      created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, delivered_at timestamptz, retry_at timestamptz,
      UNIQUE(event_id, employee_id))`);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS hivemind_employee_event_deliveries_employee ON hivemind_employee_event_deliveries(org_id, employee_id, created_at DESC)');
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS hivemind_employee_brief_reads (
      org_id text NOT NULL, employee_id text NOT NULL, event_id text NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(employee_id, event_id))`);
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
  // The profile editor writes only `company.website` (organization_profile, key `company.website`); the control plane itself treats its host as the company's verified domain.
  const [members, facts, org] = await Promise.all([
    db.userOrganization.findMany({ where: { orgId, isActive: true, deactivatedAt: null }, select: { user: { select: { email: true, deletedAt: true } } } }),
    db.organizationProfile.findMany({ where: { orgId, key: 'company.website', deletedAt: null }, select: { value: true } }),
    db.organization.findUnique({ where: { id: orgId }, select: { companyProfile: true } }),
  ]);
  const legacy = org?.companyProfile && typeof org.companyProfile === 'object' ? org.companyProfile.website : undefined;
  const host = item => { try { const value = String(item ?? '').trim(); return value ? new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; } };
  // Only the registrable domain of the website counts, and never a free mail or shared hosting domain.
  return {
    memberEmails: new Set(members.filter(row => row.user && !row.user.deletedAt).map(row => lower(row.user.email))),
    companyDomains: new Set([...facts.map(row => row.value), legacy].map(host).map(registrableDomain).filter(item => item && !untrustedDomain(item))),
  };
}

// A routing skip never blocks a later valid target: the same (event, employee) row is upgraded from skipped to pending. Delivery outcomes are final.
async function recordDelivery(db, row) {
  return db.$queryRawUnsafe(`INSERT INTO hivemind_employee_event_deliveries
    (id,org_id,user_id,employee_id,event_id,toolkit,trigger_slug,reason,watch_id,status,skip_reason,summary)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12) ON CONFLICT(event_id,employee_id) DO UPDATE SET status='pending',reason=EXCLUDED.reason,watch_id=EXCLUDED.watch_id,skip_reason=NULL
    WHERE hivemind_employee_event_deliveries.status='skipped' AND hivemind_employee_event_deliveries.attempts=0 AND EXCLUDED.status='pending' RETURNING id`,
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
  // Mentions are routed for every received event, approved or not: addressing an employee by name is the signal. Watches wait for approval.
  const mentionsOnly = deps.mentionsOnly === true;
  const watches = mentionsOnly ? [] : await db.$queryRawUnsafe('SELECT * FROM hivemind_employee_watches WHERE org_id=$1 AND toolkit=$2 AND trigger_slug=$3 AND enabled', orgId, sub.toolkit, sub.slug);
  const base = { orgId, userId, eventId: event.id, toolkit: sub.toolkit, slug: sub.slug, summary: clip(facts.title || facts.body, 140) };
  const hasMention = facts.mentionText.includes('@');
  if (!watches.length && !hasMention) {
    // Runtime on: today's path is the whole story. Runtime off: nobody reads this event, so say so in the audit.
    if (!mentionsOnly && !(deps.runtimeEnabled ?? await readRuntimeEnabled(db, orgId))) await recordDelivery(db, { ...base, employeeId: EVENT_LEVEL, reason: 'none', status: 'skipped', skipReason: 'no_target_runtime_off' });
    return { targets: [], skips: [] };
  }
  const [employees, directory] = await Promise.all([loadRoutableEmployees(db, orgId, userId), loadCompanyDirectory(db, orgId)]);
  const decision = decideRouting({ facts, orgId, eventUserId: userId, subject: sub.subject ?? null, employees, watches, directory, config });
  for (const skip of decision.skips) await recordDelivery(db, { ...base, employeeId: skip.employeeId, reason: 'candidate', status: 'skipped', skipReason: skip.reason });
  if (!mentionsOnly && !decision.targets.length && !decision.skips.length && !(deps.runtimeEnabled ?? await readRuntimeEnabled(db, orgId))) await recordDelivery(db, { ...base, employeeId: EVENT_LEVEL, reason: 'none', status: 'skipped', skipReason: 'no_target_runtime_off' });
  for (const target of decision.targets) {
    await recordDelivery(db, { ...base, employeeId: target.employeeId, reason: target.reason, watchId: target.watchIds[0], status: 'pending' });
    (deps.schedule ?? (() => scheduleFlush(db, `${orgId}:${target.employeeId}`, config.coalesceMs + 500, deps)))(target);
  }
  return decision;
}

/**
 * Routing as the classifier calls it: it can never fail or hold up intake. A call that outlasts routeTimeoutMs or throws is cut loose and
 * audited as an event-level skip (`routing_timeout`, `routing_error`) on a best-effort basis.
 * @param {object} db Prisma client.
 * @param {object} input See {@link routeApprovedEvent}.
 * @param {object} [deps] Same hooks; `config` also carries routeTimeoutMs.
 * @returns {Promise<object>} The routing result, or `{skipped}`.
 */
export async function routeEventGuarded(db, input, deps = {}) {
  const config = deps.config ?? routingConfig();
  if (!config.enabled) return { skipped: 'routing_disabled' };
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('routing_timeout'), { timeout: true })), config.routeTimeoutMs); timer.unref?.(); });
  try { return await Promise.race([routeApprovedEvent(db, input, { ...deps, config }), timeout]); }
  catch (error) {
    const skipReason = error?.timeout ? 'routing_timeout' : 'routing_error';
    const audit = recordDelivery(db, { orgId: input.orgId, userId: input.userId, eventId: input.event?.id, toolkit: input.sub?.toolkit ?? '', slug: input.sub?.slug ?? '', employeeId: EVENT_LEVEL, reason: 'none', status: 'skipped', skipReason, summary: null }).catch(() => undefined);
    await Promise.race([audit, new Promise(resolve => setTimeout(resolve, 1000).unref?.())]);
    return { skipped: skipReason };
  }
  finally { clearTimeout(timer); }
}

/** Server errors, timeouts, and 401, 408, 409 and 429 from OpenDot are temporary; any other 4xx will not change on retry. */
const RETRYABLE_STATUS = new Set([401, 408, 409, 429]);
const permanent = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && !RETRYABLE_STATUS.has(error.status);

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
    WHERE employee_id<>$3 AND ((status='pending' AND (retry_at IS NULL OR retry_at <= $4::timestamptz)) OR (status='sending' AND claimed_at < $2::timestamptz))
    GROUP BY org_id,employee_id HAVING min(created_at) <= $1::timestamptz ORDER BY min(created_at) LIMIT 32`,
  new Date(now.getTime() - config.coalesceMs).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), EVENT_LEVEL, now.toISOString());
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
      AND ((status='pending' AND (retry_at IS NULL OR retry_at <= $5::timestamptz)) OR (status='sending' AND claimed_at < $4::timestamptz)) ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING *`,
  orgId, employeeId, now.toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), now.toISOString());
  if (!rows.length) return out;
  const finish = (ids, status, reason, error) => db.$executeRawUnsafe(
    `UPDATE hivemind_employee_event_deliveries SET status=$2,skip_reason=$3,last_error=$4,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END WHERE id = ANY($1::uuid[])`,
    ids, status, reason ?? null, error ?? null);
  const watchOutcome = (ids, error) => ids.length ? db.$executeRawUnsafe(
    error ? 'UPDATE hivemind_employee_watches SET last_error=$2,updated_at=now() WHERE id = ANY($1::uuid[])' : 'UPDATE hivemind_employee_watches SET last_fired_at=now(),last_error=NULL,updated_at=now() WHERE id = ANY($1::uuid[])',
    ...(error ? [ids, error] : [ids])) : undefined;
  // A wake that waited too long is stale news: it goes to the brief instead.
  const stale = rows.filter(row => now.getTime() - new Date(row.created_at).getTime() > config.maxWakeAgeMs);
  if (stale.length) { await finish(stale.map(row => row.id), 'briefed', 'too_old'); out.briefed += stale.length; rows.splice(0, rows.length, ...rows.filter(row => !stale.includes(row))); if (!rows.length) return out; }
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
    else {
      // Retry with exponential backoff (1, 2, 4 ... up to 15 minutes); the age cap ends it earlier.
      const attempts = Math.max(...kept.map(row => row.attempts));
      const retryAt = new Date(now.getTime() + Math.min(60_000 * 2 ** (attempts - 1), 900_000)).toISOString();
      await db.$executeRawUnsafe("UPDATE hivemind_employee_event_deliveries SET status='pending',last_error=$2,retry_at=$3::timestamptz WHERE id = ANY($1::uuid[])", keptIds, code, retryAt);
    }
  }
  return out;
}
