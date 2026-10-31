/**
 * The connected-app signal the attention layer hands to an agent: evidence, exact provider ids, header fields, the attention
 * assessment and the connected-app tool slugs admitted for it. These are the same fields, limits and defaults Runtime builds for
 * its own wakes in deepseek-harness packages/hivemind/hq-runtime/src/attention-contract.ts and attention-wake.ts; keep the two in
 * step so an employee receives exactly what Runtime would.
 */

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, max);

/** Connected-app tool slugs admitted per toolkit for a signal (Runtime DEFAULT_WAKE_TOOL_SLUGS). */
export const DEFAULT_SIGNAL_TOOL_SLUGS = Object.freeze({
  gmail: ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_ADD_LABEL_TO_EMAIL', 'GMAIL_REPLY_TO_THREAD'],
  googlecalendar: ['GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_FIND_FREE_SLOTS'],
  github: ['GITHUB_GET_A_PULL_REQUEST', 'GITHUB_LIST_PULL_REQUESTS_FILES', 'GITHUB_GET_AN_ISSUE', 'GITHUB_CREATE_AN_ISSUE_COMMENT'],
  linkedin: ['LINKEDIN_GET_POST_CONTENT'],
});
/** Most tool slugs named for one signal (Runtime maxTools default). */
export const MAX_SIGNAL_TOOLS = 5;

/**
 * Title and body excerpt of an event, never the whole provider envelope.
 * @param {unknown} value Provider payload.
 * @returns {{title:string,preview:string,currentMessage?:string,quotedMessage?:string}} Bounded evidence.
 */
export function attentionEvidence(value) {
  const data = object(value) ? value : {};
  const display = object(data._hivemind) ? data._hivemind : {};
  const preview = object(data.preview) ? data.preview : {};
  const file = object(data.file) ? data.file : {};
  const body = [data.preview, data.message_text, data.text, data.body, preview.body].find(item => typeof item === 'string' && item.trim());
  const fileId = text(data.file_id || data.fileId || file.id, 300).trim();
  const title = [display.title, data.subject, data.title, file.name, data.name].find(item => typeof item === 'string' && item.trim());
  const plain = text(body, 1500);
  // Quote separation is presentation only; neither part authenticates the sender.
  const quote = plain.search(/^(?:-{2,}\s*(?:Forwarded message|Original Message)\s*-{2,}|On .+wrote:|Begin forwarded message:)/im);
  return { title: text(title, 200), preview: plain || (fileId ? `Changed file reference: ${fileId}` : ''),
    ...(quote >= 0 ? { currentMessage: plain.slice(0, quote).trim(), quotedMessage: plain.slice(quote).trim() } : {}) };
}

const PROVIDER_REF_FIELDS = ['message_id', 'messageId', 'thread_id', 'threadId', 'sender', 'from', 'to', 'message_timestamp', 'event_id', 'eventId',
  'calendar_id', 'calendarId', 'channel', 'channel_id', 'ts', 'thread_ts', 'user', 'user_id', 'post_id', 'urn', 'file_id', 'event_type'];
/**
 * Exact provider identifiers, allow-listed and bounded: untrusted claims to verify with an authorized read.
 * @param {string} toolkit Connected app.
 * @param {unknown} value Provider payload.
 * @returns {Record<string,string>} Present identifiers by provider field name.
 */
export function attentionProviderRef(toolkit, value) {
  const data = object(value) ? value : {};
  const ref = { toolkit: text(toolkit, 60) };
  const fields = toolkit === 'googlecalendar' ? [...PROVIDER_REF_FIELDS, 'id'] : PROVIDER_REF_FIELDS;
  for (const field of fields) {
    const item = data[field];
    if (typeof item === 'string' || typeof item === 'number') { const clipped = text(String(item), 300).trim(); if (clipped) ref[field] = clipped; }
  }
  return ref;
}

/**
 * Header fields the evidence preview does not carry.
 * @param {unknown} data Provider payload.
 * @param {string} toolkit Connected app.
 * @param {number} previewLength Length of the forwarded preview.
 * @returns {object} Subject, sender, date, labels and whether the excerpt is the whole body.
 */
export function signalHeader(data, toolkit, previewLength) {
  const item = object(data) ? data : {};
  const body = [item.message_text, item.text, item.body].find(value => typeof value === 'string' && value.trim() !== '');
  const labels = Array.isArray(item.label_ids) ? item.label_ids.filter(label => typeof label === 'string').slice(0, 12).map(label => label.slice(0, 80)) : [];
  const fields = { from: item.sender ?? item.from, to: item.to, subject: item.subject ?? item.title, date: item.message_timestamp ?? item.timestamp ?? item.date };
  const limits = { from: 300, to: 300, subject: 200, date: 60 };
  return { app: toolkit, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value.slice(0, limits[key])])),
    ...(labels.length ? { labels } : {}), ...(body === undefined ? {} : { excerptComplete: body.length <= previewLength }) };
}

/**
 * The attention layer's judgement in words an agent can act on.
 * @param {object|undefined} decision Stored attention decision.
 * @returns {Record<string,string>} Disposition, reason and the need, novelty and urgency answers when present.
 */
export function signalAssessment(decision) {
  const part = key => (object(decision?.[key]) && typeof decision[key].choice === 'string' ? decision[key].choice : undefined);
  return {
    ...(typeof decision?.action === 'string' ? { suggestedDisposition: decision.action } : {}),
    ...(typeof decision?.reason === 'string' ? { reason: text(decision.reason, 300) } : {}),
    ...(typeof decision?.choice === 'string' ? { need: decision.choice } : part('assessment') ? { need: part('assessment') } : {}),
    ...(part('novelty') ? { novelty: part('novelty') } : {}),
    ...(part('urgency') ? { urgency: part('urgency') } : {}),
  };
}

/**
 * Tool slugs admitted for a signal's toolkit.
 * @param {string} toolkit Connected app.
 * @param {Record<string,string[]>} [slugs] Slugs per toolkit.
 * @returns {string[]} At most MAX_SIGNAL_TOOLS slugs of that toolkit.
 */
export function signalToolSlugs(toolkit, slugs = DEFAULT_SIGNAL_TOOL_SLUGS) {
  const prefix = `${String(toolkit).toUpperCase()}_`;
  return (slugs[String(toolkit).toLowerCase()] ?? []).filter(slug => slug.startsWith(prefix)).slice(0, MAX_SIGNAL_TOOLS);
}

const SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/u;
/**
 * The full signal for one event. When Runtime's attention judged it for the employees (`attentionForEmployees`), the assessment and
 * the tool slugs are that verdict's; otherwise the stored decision's assessment and the default slugs of the toolkit.
 * @param {{toolkit:string,data:unknown,decision?:object,routedBecause?:string}} input Event and its stored decision.
 * @returns {{evidence:object,providerRef:object,signal:object,assessment:object,appTools?:object,routedBecause?:string}} The signal.
 */
export function attentionSignal({ toolkit, data, decision, routedBecause }) {
  const evidence = attentionEvidence(data);
  const verdict = object(decision?.attentionForEmployees) ? decision.attentionForEmployees : undefined;
  const prefix = `${String(toolkit).toUpperCase()}_`;
  const slugs = Array.isArray(verdict?.toolSlugs)
    ? verdict.toolSlugs.filter(slug => typeof slug === 'string' && SLUG.test(slug) && slug.startsWith(prefix)).slice(0, MAX_SIGNAL_TOOLS)
    : signalToolSlugs(toolkit);
  decision = verdict ?? decision;
  return { evidence, providerRef: attentionProviderRef(toolkit, data), signal: signalHeader(data, toolkit, evidence.preview.length),
    assessment: signalAssessment(decision), ...(slugs.length ? { appTools: { toolkit: String(toolkit).toLowerCase(), slugs } } : {}),
    ...(routedBecause ? { routedBecause: text(routedBecause, 300) } : {}) };
}
