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
  const recent = transcript.slice(-24).map((turn) => ({
    turn_id: turn.id || turn.turn_id || null,
    speaker_user_id: turn.speaker_user_id || null,
    speaker: normalizeRoomText(turn.speaker_name, 120),
    role: normalizeRoomText(turn.speaker_role || 'member', 60),
    text: normalizeRoomText(turn.text, 1200),
    at: turn.at,
  }));
  const state = room?.roomPlaybook && typeof room.roomPlaybook === 'object' ? room.roomPlaybook : {};
  const brief = state.session_brief || {};
  return {
    room: { id: room.id, name: room.name, goal: normalizeRoomText(room.goal, 800) },
    current_speaker: speaker,
    participants: roster.slice(0, 50).map((person) => ({
      user_id: person.user_id,
      name: normalizeRoomText(person.name, 120),
      role: normalizeRoomText(person.role || 'member', 60),
    })),
    recent_transcript: recent,
    session: {
      goal_state: normalizeRoomText(brief.summary || state.goal_state || '', 2400),
      decisions: (brief.decisions || state.decisions || []).slice(-12).map(item => normalizeRoomText(item.text || item,300)),
      open_items: (brief.open_items || state.open_items || []).slice(-12).map(item => normalizeRoomText(item.text || item,300)),
      next_focus: normalizeRoomText(brief.next_focus,400),
      agenda: (state.agenda || []).slice(0,12).map(item => normalizeRoomText(item,200)),
    },
    instruction: 'You are HIVEMIND, the disclosed AI facilitator in a multi-person operating room. Answer the current verified speaker by name when natural, consider every recent speaker, use HIVEMIND recall for company facts, never invent missing facts, keep the room moving toward its goal, and distinguish decisions from unresolved items.',
  };
}

export function buildRoomChatRequest({ room, turn, context }) {
  const people = (context.participants || []).map((person) => `${person.name} (${person.role})`).join(', ');
  const recent = (context.recent_transcript || []).map((item) => (
    `${item.speaker} (${item.role}${item.speaker_user_id ? `, user ${item.speaker_user_id}` : ''}): ${item.text}`
  )).join('\n');
  const session = context.session || {};
  const prompt = [
    '[OPERATING ROOM — SERVER VERIFIED CONTEXT]',
    `Room: ${context.room?.name || room.name}.`,
    `Goal: ${context.room?.goal || room.goal || 'Facilitate the company discussion.'}`,
    `Current speaker: ${turn.speaker_name} (${turn.speaker_role}, user ${turn.speaker_user_id}).`,
    people ? `Participants: ${people}.` : '',
    session.agenda?.length ? `Shared agenda: ${session.agenda.join('; ')}` : '',
    session.goal_state ? `Current goal state: ${session.goal_state}` : '',
    session.decisions?.length ? `Decisions so far: ${session.decisions.join('; ')}` : '',
    session.open_items?.length ? `Still open: ${session.open_items.join('; ')}` : '',
    session.next_focus ? `Suggested next focus: ${session.next_focus}` : '',
    recent ? `Recent room transcript:\n${recent}` : '',
    '[RESPONSE CONTRACT]',
    `Respond to ${turn.speaker_name}'s latest request below. Speak naturally for voice (normally 1-4 short sentences). Use the shared room context and grounded HIVEMIND recall when facts are needed. Do not expose internal tool traces. Do not claim a decision was made unless the transcript shows it. If the room is off track, briefly steer it toward the goal.`,
    `${turn.speaker_name}: ${normalizeRoomText(turn.query || turn.text, 4000)}`,
  ].filter(Boolean).join('\n\n');
  return {
    message: prompt,
    stream: false,
    router: 'tool',
    // Native V2 still uses the full HIVEMIND recall/tool loop. Connected apps
    // remain unavailable in a live room unless a future governed approval flow
    // explicitly grants them.
    use_tools: false,
    scope: 'organization',
    history_turns: 8,
    conversation_id: room.id,
    idempotency_key: `operating-room-turn:${turn.id}`,
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
    facilitator: state.facilitator || null,
    facilitator_status: state.facilitator_status || 'unavailable',
    facilitator_activity: state.facilitator_activity || 'listening',
    agenda: Array.isArray(state.agenda) ? state.agenda : [],
    session_brief: state.session_brief || null,
    recent_responses: (state.facilitator_responses || []).slice(-6),
    participants: Array.isArray(state.participants) ? state.participants : [],
    created_at: room.createdAt,
    updated_at: room.updatedAt,
  };
}
