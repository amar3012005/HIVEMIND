// Team operating-memory kinds (lesson, procedure, progress, agenda), their
// bounded field validation, and the pure ranking used by the brief recall.
// Database access stays in operating-memory.js; nothing here touches storage.
import { createHash } from 'node:crypto';

export const TEAM_KINDS = Object.freeze(['lesson', 'procedure', 'progress', 'agenda']);
/** Kinds whose newest revision per key replaces the previous one. */
export const KEYED_KINDS = Object.freeze(['progress', 'agenda']);
/** Kinds that colleagues can confirm; two confirmations promote them. */
export const CONFIRMABLE_KINDS = Object.freeze(['lesson', 'procedure']);
export const PROMOTION_THRESHOLD = 2;
export const BRIEF_DEFAULT_LIMIT = 8;
export const BRIEF_MAX_CHARS = 2000;
export const TEAM_CONTEXT_MAX_CHARS = 12000;
export const MAX_CONFIRMATIONS = 20;

const FIELDS = Object.freeze({
  lesson: ['when', 'do', 'because', 'confidence'],
  procedure: ['trigger', 'steps', 'check', 'source'],
  progress: ['task_key', 'goal', 'done', 'next', 'open_questions', 'evidence'],
  agenda: ['agenda_key', 'outcome', 'target', 'milestones', 'task_keys'],
});
/** Request fields that only exist for team kinds (agenda also reads `status`). */
export const TEAM_FIELD_NAMES = Object.freeze([...new Set(Object.values(FIELDS).flat())]);
export const AGENDA_STATUSES = Object.freeze(['active', 'paused', 'done', 'dropped']);
export const PROCEDURE_SOURCES = Object.freeze(['learned', 'shown']);

const TASK_KEY = /^[a-z0-9][a-z0-9:_./-]{0,119}$/i;
const AGENDA_KEY = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(kind, field) {
  throw new Error(`invalid_${kind}_${field}`);
}

function text(kind, field, value, max, { optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return undefined;
    fail(kind, field);
  }
  if (typeof value !== 'string') fail(kind, field);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) fail(kind, field);
  return trimmed;
}

function list(kind, field, value, { maxItems, maxLength, min = 0 }) {
  if (value == null) value = [];
  if (!Array.isArray(value) || value.length < min || value.length > maxItems) fail(kind, field);
  return value.map(item => {
    if (typeof item !== 'string') fail(kind, field);
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxLength) fail(kind, field);
    return trimmed;
  });
}

function truncate(value, max) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function normalizeLesson(input) {
  const confidence = input.confidence == null ? 0.5 : input.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail('lesson', 'confidence');
  const fields = {
    when: text('lesson', 'when', input.when, 300),
    do: text('lesson', 'do', input.do, 500),
    because: text('lesson', 'because', input.because, 500),
    confidence,
  };
  return {
    fields,
    title: `When ${fields.when}`,
    summary: `When ${fields.when}, do ${fields.do}. Because ${fields.because}.`,
  };
}

function normalizeProcedure(input) {
  const source = input.source == null ? 'learned' : input.source;
  if (!PROCEDURE_SOURCES.includes(source)) fail('procedure', 'source');
  const fields = {
    trigger: text('procedure', 'trigger', input.trigger, 300),
    steps: list('procedure', 'steps', input.steps, { maxItems: 12, maxLength: 300, min: 1 }),
    check: text('procedure', 'check', input.check, 300),
    source,
  };
  return {
    fields,
    title: `Procedure: ${fields.trigger}`,
    summary: `Trigger: ${fields.trigger}. Steps: ${fields.steps.map((step, index) => `${index + 1}) ${step}`).join(' ')} Check: ${fields.check}`,
  };
}

function normalizeProgress(input) {
  const taskKey = text('progress', 'task_key', input.task_key, 120);
  if (!TASK_KEY.test(taskKey)) fail('progress', 'task_key');
  const fields = {
    task_key: taskKey,
    goal: text('progress', 'goal', input.goal, 400),
    done: list('progress', 'done', input.done, { maxItems: 12, maxLength: 200 }),
    next: list('progress', 'next', input.next, { maxItems: 8, maxLength: 200 }),
    open_questions: list('progress', 'open_questions', input.open_questions, { maxItems: 8, maxLength: 200 }),
    evidence: list('progress', 'evidence', input.evidence, { maxItems: 8, maxLength: 300 }),
  };
  const parts = [`Goal: ${fields.goal}.`];
  if (fields.done.length) parts.push(`Done: ${fields.done.join('; ')}.`);
  if (fields.next.length) parts.push(`Next: ${fields.next.join('; ')}.`);
  if (fields.open_questions.length) parts.push(`Open: ${fields.open_questions.join('; ')}.`);
  return { fields, title: `Progress: ${fields.goal}`, summary: parts.join(' '), key: taskKey };
}

function normalizeTarget(value) {
  const raw = typeof value === 'string' ? { text: value } : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('agenda', 'target');
  if (Object.keys(raw).some(key => !['text', 'value', 'unit'].includes(key))) fail('agenda', 'target');
  const target = { text: text('agenda', 'target', raw.text, 200) };
  if (raw.value != null) {
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value) || Math.abs(raw.value) > 1e15) fail('agenda', 'target');
    target.value = raw.value;
  }
  if (raw.unit != null) target.unit = text('agenda', 'target', raw.unit, 40);
  return target;
}

function normalizeMilestones(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) fail('agenda', 'milestones');
  return value.map(item => {
    const raw = typeof item === 'string' ? { text: item } : item;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('agenda', 'milestones');
    if (Object.keys(raw).some(key => !['text', 'done', 'due'].includes(key))) fail('agenda', 'milestones');
    if (raw.done != null && typeof raw.done !== 'boolean') fail('agenda', 'milestones');
    if (raw.due != null && (typeof raw.due !== 'string' || !DUE_DATE.test(raw.due))) fail('agenda', 'milestones');
    return { text: text('agenda', 'milestones', raw.text, 200), done: raw.done === true, ...(raw.due ? { due: raw.due } : {}) };
  });
}

function normalizeAgenda(input) {
  const agendaKey = text('agenda', 'agenda_key', input.agenda_key, 80);
  if (!AGENDA_KEY.test(agendaKey)) fail('agenda', 'agenda_key');
  const status = input.status == null ? 'active' : input.status;
  if (!AGENDA_STATUSES.includes(status)) fail('agenda', 'status');
  const taskKeys = list('agenda', 'task_keys', input.task_keys, { maxItems: 12, maxLength: 120 });
  if (taskKeys.some(key => !TASK_KEY.test(key))) fail('agenda', 'task_keys');
  const fields = {
    agenda_key: agendaKey,
    outcome: text('agenda', 'outcome', input.outcome, 400),
    target: normalizeTarget(input.target),
    milestones: normalizeMilestones(input.milestones),
    task_keys: taskKeys,
    status,
  };
  const targetText = `${fields.target.text}${fields.target.value != null ? ` (${fields.target.value}${fields.target.unit ? ` ${fields.target.unit}` : ''})` : ''}`;
  return {
    fields,
    title: `Agenda: ${fields.outcome}`,
    summary: `Outcome: ${fields.outcome}. Target: ${targetText}. Status: ${status}.${fields.milestones.length ? ` Milestones: ${fields.milestones.map(m => `${m.done ? '[x]' : '[ ]'} ${m.text}`).join('; ')}.` : ''}`,
    key: agendaKey,
  };
}

const NORMALIZERS = { lesson: normalizeLesson, procedure: normalizeProcedure, progress: normalizeProgress, agenda: normalizeAgenda };

/**
 * Reject team-only fields on kinds that do not own them, so existing kinds keep
 * their exact request contract.
 * @param {string} kind
 * @param {object} input Raw request body.
 * @returns {void}
 */
export function assertNoForeignTeamFields(kind, input) {
  const owned = new Set(FIELDS[kind] || []);
  for (const field of TEAM_FIELD_NAMES) {
    if (!owned.has(field) && input?.[field] != null) throw new Error('invalid_memory_field');
  }
}

/**
 * Validate a team-kind save body and derive its searchable title and summary.
 * @param {'lesson'|'procedure'|'progress'|'agenda'} kind
 * @param {object} input Raw request body.
 * @returns {{ fields: object, title: string, summary: string, key?: string }} Normalized fields stored in `context`, plus defaults for `title` and `summary`.
 */
export function normalizeTeamFields(kind, input) {
  assertNoForeignTeamFields(kind, input);
  if (input?.context != null && !(typeof input.context === 'object' && !Array.isArray(input.context) && Object.keys(input.context).length === 0)) {
    throw new Error('invalid_memory_field');
  }
  const result = NORMALIZERS[kind](input);
  if (JSON.stringify(result.fields).length > TEAM_CONTEXT_MAX_CHARS) throw new Error('memory_context_too_large');
  return { ...result, summary: truncate(result.summary, 2400), title: truncate(result.title, 180) };
}

/**
 * Stable idempotency key for team saves that omit one: identical content from
 * the same employee replays instead of duplicating.
 * @param {string} kind
 * @param {string} agentSlug
 * @param {object} fields Normalized fields.
 * @returns {string} At most 60 characters.
 */
export function deriveIdempotencyKey(kind, agentSlug, fields) {
  return `${kind}:${createHash('sha256').update(JSON.stringify([kind, agentSlug, fields])).digest('hex').slice(0, 40)}`;
}

/**
 * Public view of a stored confirmation list without server-bound user ids.
 * @param {object} context Stored row context.
 * @returns {{ agentSlug: string, at: string }[]}
 */
export function publicConfirmations(context) {
  return (Array.isArray(context?.confirmations) ? context.confirmations : []).map(entry => ({ agentSlug: entry.agent_slug, at: entry.at }));
}

/** Strip server-bound ids from a stored context before it leaves the service. */
export function publicTeamContext(context) {
  const { confirmations, ...rest } = context || {};
  return rest;
}

// ---- Brief ranking -------------------------------------------------------

const STOP = new Set(['with', 'from', 'that', 'this', 'what', 'when', 'where', 'about', 'have', 'their', 'them', 'your', 'into', 'will', 'task', 'work', 'the', 'and', 'for', 'are', 'was', 'not', 'you', 'can', 'but', 'has', 'how', 'its']);

/**
 * Lowercase word terms (three or more letters or digits) without stop words.
 * @param {string} value
 * @returns {string[]} Unique terms.
 */
export function tokenize(value) {
  return [...new Set(String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(term => !STOP.has(term));
}

function contextText(context) {
  const parts = [];
  for (const [key, value] of Object.entries(context || {})) {
    if (['confirmations', 'promoted', 'promoted_at', 'supersedesId'].includes(key)) continue;
    parts.push(typeof value === 'string' ? value : JSON.stringify(value));
  }
  return parts.join(' ');
}

/** One-line gist (at most 90 characters) for a stored row. */
export function gistFor(row) {
  const c = row.context || {};
  let gist;
  switch (row.kind) {
    case 'lesson': gist = `${c.when || ''} → ${c.do || ''}`; break;
    case 'procedure': gist = `${c.trigger || ''} → ${(c.steps || []).length} steps`; break;
    case 'progress': gist = `${c.next?.[0] ? `next: ${c.next[0]}` : c.goal || ''}`; break;
    case 'agenda': gist = `${c.outcome || ''} [${c.status || 'active'}]`; break;
    default: gist = String(row.summary || '').split('\n')[0];
  }
  return truncate(gist || row.summary, 90);
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Score one row for a brief.
 * Weights: relevance 0.45, recency 0.25 (14-day half-life), entity hints 0.20,
 * same agent 0.10, plus 0.05 for promoted team knowledge.
 * @param {object} row Stored row with kind, title, summary, context, agent_slug, created_at.
 * @param {{ terms: string[], hints: string[], agentSlug: string|null, now: number }} query
 * @returns {number}
 */
export function scoreForBrief(row, { terms, hints, agentSlug, now }) {
  const haystack = `${row.title} ${row.summary} ${contextText(row.context)}`.toLocaleLowerCase();
  const rowTerms = new Set(tokenize(haystack));
  let relevance = 0;
  if (terms.length) relevance = Math.min(1, terms.filter(term => rowTerms.has(term)).length / Math.min(terms.length, 8));
  let hint = 0;
  if (hints.length) {
    const matched = hints.filter(h => haystack.includes(h)).length;
    if (matched) hint = 0.5 + 0.5 * (matched / hints.length);
  }
  const ageDays = Math.max(0, (now - new Date(row.created_at).getTime()) / 86400000);
  const recency = 0.5 ** (ageDays / 14);
  const sameAgent = agentSlug && row.agent_slug === agentSlug ? 1 : 0;
  const promoted = CONFIRMABLE_KINDS.includes(row.kind) && row.context?.promoted === true ? 1 : 0;
  return 0.45 * relevance + 0.25 * recency + 0.2 * hint + 0.1 * sameAgent + 0.05 * promoted;
}

/**
 * Rank rows and build the compact brief items.
 * @param {object[]} rows Candidate rows.
 * @param {{ context?: string|null, hints?: string[], agentSlug?: string|null, limit: number, now?: number, maxChars?: number }} options
 * @returns {{ items: object[], truncated: boolean }} At most `limit` items whose JSON stays within `maxChars` (the top item is always kept).
 */
export function buildBrief(rows, { context = null, hints = [], agentSlug = null, limit, now = Date.now(), maxChars = BRIEF_MAX_CHARS }) {
  const query = { terms: tokenize(context), hints: hints.map(h => h.toLocaleLowerCase()), agentSlug, now };
  const ranked = rows
    .map(row => ({ row, score: scoreForBrief(row, query) }))
    .sort((a, b) => b.score - a.score || new Date(b.row.created_at) - new Date(a.row.created_at) || String(b.row.id).localeCompare(String(a.row.id)));
  const items = ranked.slice(0, limit).map(({ row }) => ({
    id: row.id,
    kind: row.kind,
    title: truncate(row.title, 50),
    gist: gistFor(row),
    author: row.agent_slug,
    updated_at: iso(row.created_at),
    ...(CONFIRMABLE_KINDS.includes(row.kind) && row.context?.promoted === true ? { promoted: true } : {}),
  }));
  let truncated = false;
  while (items.length > 1 && JSON.stringify(items).length > maxChars) { items.pop(); truncated = true; }
  return { items, truncated };
}
