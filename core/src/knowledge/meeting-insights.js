import { groqFetch } from '../llm/groq-fallback.js';

const WINDOW_CHARS = 48_000;
const BASE_PROMPT = 'You are an expert meeting analyst. From the transcript and optional user notes produce STRICT JSON: {"title": string, "summary": string, "key_points": string[], "action_items": [{"task": string, "owner": string|null, "due": string|null}], "decisions": string[], "questions": string[], "topics": string[], "sentiment": string, "quotes": [{"quote": string, "speaker": string|null}], "risks": string[], "next_steps": string[], "entities": {"people": string[], "organizations": string[], "dates": string[]}, "speaker_names": object}. Preserve the transcript language. Be faithful, never invent facts, and use empty arrays or objects when none.';

function participantNames(participants) {
  if (!Array.isArray(participants)) return [];
  return participants.map((item) => typeof item === 'string' ? item : item?.name)
    .map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30);
}

async function canonicalEntityHint(prisma, orgId) {
  if (!prisma || !orgId) return '';
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tag, count(*) c FROM (
         SELECT unnest(tags) tag FROM hivemind.memories
          WHERE org_id=$1::uuid AND deleted_at IS NULL AND is_latest=true
       ) t WHERE tag LIKE 'entity:%' OR tag LIKE 'person:%'
       GROUP BY tag ORDER BY c DESC LIMIT 80`, orgId,
    );
    const seen = new Set(); const names = [];
    for (const row of rows || []) {
      const name = String(row.tag).replace(/^(entity|person):/, '').replace(/[-_]+/g, ' ').trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const key = name.toLowerCase();
      if (name.length > 1 && !seen.has(key)) { seen.add(key); names.push(name); }
      if (names.length >= 50) break;
    }
    return names.length
      ? `\n\nKNOWN ORGANIZATION ENTITIES: ${names.join('; ')}. Normalize confident variants to these names, but never force an unrelated match.`
      : '';
  } catch (error) {
    console.warn('[meeting-insights] canonical entity lookup failed:', error?.message || error);
    return '';
  }
}

async function callMeetingModel(messages, timeoutMs = 120_000) {
  const model = process.env.MEETING_INSIGHTS_MODEL || 'openai/gpt-oss-120b';
  const endpoint = `${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`;
  const response = await groqFetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`meeting insights ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || '';
  try { return JSON.parse(content); }
  catch { throw new Error('meeting insights returned malformed JSON'); }
}

function transcriptWindows(transcript) {
  const windows = [];
  let start = 0;
  while (start < transcript.length) {
    let end = Math.min(start + WINDOW_CHARS, transcript.length);
    if (end < transcript.length) {
      const newline = transcript.lastIndexOf('\n', end);
      if (newline > start + WINDOW_CHARS * 0.6) end = newline;
    }
    windows.push(transcript.slice(start, end));
    start = end;
  }
  return windows;
}

function mergeMeetingParts(parts) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const mergeArray = (key, textOf) => {
    const seen = new Set(); const output = [];
    for (const part of parts) for (const item of Array.isArray(part[key]) ? part[key] : []) {
      const keyValue = normalize(textOf(item));
      if (keyValue.length < 2 || seen.has(keyValue)) continue;
      seen.add(keyValue); output.push(item);
    }
    return output;
  };
  return {
    title: parts.find((part) => part.title)?.title || 'Meeting',
    summary: parts.map((part) => part.summary).filter(Boolean).join(' '),
    key_points: mergeArray('key_points', String).slice(0, 30),
    action_items: mergeArray('action_items', (item) => typeof item === 'string' ? item : item?.task).slice(0, 30),
    decisions: mergeArray('decisions', String).slice(0, 24),
    questions: mergeArray('questions', (item) => typeof item === 'string' ? item : item?.question || item?.text).slice(0, 24),
    risks: mergeArray('risks', String).slice(0, 24),
    next_steps: mergeArray('next_steps', String).slice(0, 24),
    quotes: mergeArray('quotes', (item) => typeof item === 'string' ? item : item?.quote).slice(0, 8),
    topics: [...new Set(parts.flatMap((part) => Array.isArray(part.topics) ? part.topics : []))].slice(0, 24),
    sentiment: parts.find((part) => part.sentiment)?.sentiment || null,
    entities: {
      people: [...new Set(parts.flatMap((part) => part.entities?.people || []))].slice(0, 40),
      organizations: [...new Set(parts.flatMap((part) => part.entities?.organizations || []))].slice(0, 30),
      dates: [...new Set(parts.flatMap((part) => part.entities?.dates || []))].slice(0, 30),
    },
    speaker_names: Object.assign({}, ...parts.map((part) => part.speaker_names && typeof part.speaker_names === 'object' ? part.speaker_names : {})),
  };
}

export async function generateMeetingInsights({ prisma = null, orgId, transcript, notes = '', participants = [] }) {
  const source = String(transcript || '').trim();
  if (!source) throw new Error('no_transcript');
  const names = participantNames(participants);
  const participantsBlock = names.length ? `PARTICIPANTS:\n${names.join(', ')}\n\n` : '';
  const notesBlock = notes ? `USER NOTES:\n${String(notes).slice(0, 4000)}\n\n` : '';
  const system = BASE_PROMPT + await canonicalEntityHint(prisma, orgId);
  const windows = transcriptWindows(source);
  if (windows.length === 1) {
    return { insights: await callMeetingModel([{ role: 'system', content: system }, { role: 'user', content: `${participantsBlock}${notesBlock}TRANSCRIPT:\n${source}` }]), windows: 1 };
  }
  const parts = new Array(windows.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(2, windows.length) }, async () => {
    while (cursor < windows.length) {
      const index = cursor++;
      parts[index] = await callMeetingModel([
        { role: 'system', content: system },
        { role: 'user', content: `${participantsBlock}${notesBlock}TRANSCRIPT PART ${index + 1}/${windows.length}:\n${windows[index]}` },
      ]);
    }
  });
  await Promise.all(workers);
  const merged = mergeMeetingParts(parts);
  try {
    const reduced = await callMeetingModel([
      { role: 'system', content: 'Merge sequential meeting summaries into STRICT JSON {"summary": string}. Preserve important qualifiers, disagreements, dates, decisions and unresolved items.' },
      { role: 'user', content: parts.map((part, index) => `Part ${index + 1}: ${part.summary || ''}`).join('\n') },
    ], 60_000);
    if (reduced.summary) merged.summary = reduced.summary;
  } catch { /* the complete concatenated summaries remain a grounded fallback */ }
  return { insights: merged, windows: windows.length };
}

export const __test = { transcriptWindows, mergeMeetingParts, participantNames };
