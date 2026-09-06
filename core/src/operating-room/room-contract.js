const WAKE_PHRASE = /(?:^|[\s,.:;!?])(hive[\s-]*mind|tara)(?=[\s,.:;!?]|$)/i;

export function normalizeRoomText(value, max = 4000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

export function wakeIntent(text) {
  const clean = normalizeRoomText(text);
  const match = clean.match(WAKE_PHRASE);
  if (!match) return { addressed: false, query: '' };
  return {
    addressed: true,
    query: clean.slice((match.index || 0) + match[0].length).replace(/^[\s,.:;!?-]+/, '') || clean,
  };
}

export function compactRoomContext({ room, roster = [], transcript = [], speaker }) {
  const recent = transcript.slice(-10).map((turn) => ({
    speaker: normalizeRoomText(turn.speaker_name, 120),
    role: normalizeRoomText(turn.speaker_role || 'member', 60),
    text: normalizeRoomText(turn.text, 1200),
    at: turn.at,
  }));
  return {
    room: { id: room.id, name: room.name, goal: normalizeRoomText(room.goal, 800) },
    current_speaker: speaker,
    participants: roster.slice(0, 50).map((person) => ({
      user_id: person.user_id,
      name: normalizeRoomText(person.name, 120),
      role: normalizeRoomText(person.role || 'member', 60),
    })),
    recent_transcript: recent,
    instruction: 'You are HIVEMIND, the disclosed AI facilitator in a group operating room. Address people by their verified names, stay grounded in company knowledge, and do not assume the current speaker is the only participant.',
  };
}

export function roomProjection(room) {
  const state = room?.roomPlaybook && typeof room.roomPlaybook === 'object' ? room.roomPlaybook : {};
  return {
    id: room.id,
    name: room.name,
    goal: room.goal || '',
    status: state.status || 'open',
    media_provider: state.media_provider || 'cloudflare-realtimekit',
    meeting_id: state.meeting_id || null,
    participants: Array.isArray(state.participants) ? state.participants : [],
    created_at: room.createdAt,
    updated_at: room.updatedAt,
  };
}
