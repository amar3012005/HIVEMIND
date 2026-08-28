import crypto from 'crypto';

class EnterpriseChatError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'EnterpriseChatError';
    this.statusCode = statusCode;
  }
}

function normalizeTurnRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'user' || role === 'agent') return role;
  throw new EnterpriseChatError('turn must be either user or agent', 400);
}

function normalizeString(value, fieldName, { required = false, maxLength = 20000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new EnterpriseChatError(`${fieldName} is required`, 400);
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    if (required) throw new EnterpriseChatError(`${fieldName} is required`, 400);
    return null;
  }

  if (normalized.length > maxLength) {
    throw new EnterpriseChatError(`${fieldName} exceeds maximum length`, 413);
  }

  return normalized;
}

function parseTurnNumber(tags = []) {
  const turnTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith('turn:'));
  if (!turnTag) return null;
  const parsed = Number.parseInt(turnTag.slice(5), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractMessages(content = '') {
  const userMatch = content.match(/User:\s*([\s\S]*?)(?:\nAssistant:|$)/);
  const agentMatch = content.match(/Assistant:\s*([\s\S]*?)$/);
  return {
    userMessage: userMatch ? userMatch[1].trim() : null,
    assistantMessage: agentMatch ? agentMatch[1].trim() : null,
  };
}

function buildTurnContent({ userMessage, assistantMessage }) {
  const lines = [];
  if (userMessage) lines.push(`User: ${userMessage}`);
  if (assistantMessage) lines.push(`Assistant: ${assistantMessage}`);
  return lines.join('\n');
}

function buildTurnTitle(turnNumber, sessionId) {
  return `Enterprise Chat Turn ${turnNumber} — ${sessionId.slice(0, 12)}`;
}

export class EnterpriseChatService {
  constructor({ memoryStore }) {
    this.memoryStore = memoryStore;
  }

  _normalizePayload(body = {}, { userId, orgId }, { requireSid = false } = {}) {
    const effectiveUserId = normalizeString(userId || body.user_id, 'user_id', { required: true, maxLength: 128 });
    const effectiveOrgId = normalizeString(orgId || body.org_id, 'org_id', { required: true, maxLength: 128 });
    const sessionId = normalizeString(body.sid, 'sid', { required: requireSid, maxLength: 200 }) || crypto.randomUUID();
    const role = normalizeTurnRole(body.turn);
    const content = normalizeString(body.content || body.message || body.text, 'content', { required: true });
    const project = normalizeString(body.project || body.containerTag, 'project', { maxLength: 200 }) || 'enterprise/chat';
    const platform = normalizeString(body.platform, 'platform', { maxLength: 120 });
    const agentName = normalizeString(body.agent_name || body.agent, 'agent_name', { maxLength: 120 });
    const messageId = normalizeString(body.message_id, 'message_id', { maxLength: 200 });
    const parentMessageId = normalizeString(body.parent_message_id, 'parent_message_id', { maxLength: 200 });
    const idempotencyKey = normalizeString(body.idempotency_key, 'idempotency_key', { maxLength: 200 });
    const visibility = body.targetScope === 'organization' ? 'organization' : 'private';
    const requestedTurnNumber = body.turn_number == null
      ? null
      : Number.parseInt(String(body.turn_number), 10);

    if (body.turn_number != null && !Number.isFinite(requestedTurnNumber)) {
      throw new EnterpriseChatError('turn_number must be an integer when provided', 400);
    }

    return {
      userId: effectiveUserId,
      orgId: effectiveOrgId,
      sid: sessionId,
      role,
      content,
      project,
      platform,
      agentName,
      messageId,
      parentMessageId,
      idempotencyKey,
      visibility,
      requestedTurnNumber,
      clientMetadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {},
    };
  }

  async _listSessionTurns({ userId, orgId, sid }) {
    const { memories } = await this.memoryStore.listMemories({
      user_id: userId,
      org_id: orgId,
      tags: ['enterprise-chat-turn', `sid:${sid}`],
      limit: 100,
    });

    return (memories || [])
      .map((memory) => ({ ...memory, turn_number: parseTurnNumber(memory.tags || []) || 0 }))
      .sort((left, right) => left.turn_number - right.turn_number);
  }

  async _findReplay({ userId, orgId, sid, idempotencyKey }) {
    if (!idempotencyKey) return null;
    const { memories } = await this.memoryStore.listMemories({
      user_id: userId,
      org_id: orgId,
      tags: ['enterprise-chat-turn', `sid:${sid}`, `idem:${idempotencyKey}`],
      limit: 1,
    });
    if (!memories?.length) return null;
    return { ...memories[0], turn_number: parseTurnNumber(memories[0].tags || []) || 0 };
  }

  async _createTurnMemory(payload, { userMessage, assistantMessage, turnNumber, previousTurnId, createdVia }) {
    const turnId = crypto.randomUUID();
    const isComplete = !!(userMessage && assistantMessage);
    const tags = [
      'enterprise-chat-turn',
      `sid:${payload.sid}`,
      `turn:${turnNumber}`,
      `status:${isComplete ? 'complete' : 'pending'}`,
      `role:${payload.role}`,
    ];

    if (payload.platform) tags.push(`platform:${payload.platform}`);
    if (payload.agentName) tags.push(`agent:${payload.agentName}`);
    if (payload.idempotencyKey) tags.push(`idem:${payload.idempotencyKey}`);

    const created = await this.memoryStore.createMemory({
      id: turnId,
      user_id: payload.userId,
      org_id: payload.orgId,
      visibility: payload.visibility,
      project: payload.project,
      content: buildTurnContent({ userMessage, assistantMessage }),
      title: buildTurnTitle(turnNumber, payload.sid),
      tags,
      memory_type: 'event',
      document_date: new Date().toISOString(),
      source_metadata: {
        source_type: 'enterprise_chat',
        source_platform: payload.platform || 'enterprise_chat',
        source_id: payload.messageId,
        thread_id: payload.sid,
        parent_message_id: payload.parentMessageId,
      },
      metadata: {
        conversation_type: 'enterprise_chat',
        created_via: createdVia,
        session_id: payload.sid,
        turn_number: turnNumber,
        turn_role: payload.role,
        user_id: payload.userId,
        org_id: payload.orgId,
        user_message: userMessage,
        assistant_message: assistantMessage,
        platform: payload.platform,
        agent_name: payload.agentName,
        status: isComplete ? 'complete' : 'pending',
        node_color: 'teal',
        ...payload.clientMetadata,
      },
    });

    // Turn order is already deterministic in session_id + turn_number metadata;
    // do not turn chronology into a semantic Extends relationship.

    return { ...created, turn_number: turnNumber };
  }

  async _updateTurnMemory(memory, payload, { userMessage, assistantMessage, createdVia }) {
    const turnNumber = memory.turn_number || parseTurnNumber(memory.tags || []) || 0;
    const updatedTags = (memory.tags || [])
      .filter((tag) => !String(tag).startsWith('status:') && !String(tag).startsWith('role:'));
    updatedTags.push('status:complete', `role:${payload.role}`);
    if (payload.idempotencyKey && !updatedTags.includes(`idem:${payload.idempotencyKey}`)) {
      updatedTags.push(`idem:${payload.idempotencyKey}`);
    }

    const updated = await this.memoryStore.updateMemory(memory.id, {
      content: buildTurnContent({ userMessage, assistantMessage }),
      tags: updatedTags,
      source_metadata: {
        source_type: 'enterprise_chat',
        source_platform: payload.platform || 'enterprise_chat',
        source_id: payload.messageId,
        thread_id: payload.sid,
        parent_message_id: payload.parentMessageId,
      },
      metadata: {
        conversation_type: 'enterprise_chat',
        created_via: createdVia,
        session_id: payload.sid,
        turn_number: turnNumber,
        turn_role: payload.role,
        user_id: payload.userId,
        org_id: payload.orgId,
        user_message: userMessage,
        assistant_message: assistantMessage,
        platform: payload.platform,
        agent_name: payload.agentName,
        status: 'complete',
        node_color: 'teal',
        ...payload.clientMetadata,
      },
      updated_at: new Date().toISOString(),
    });

    return { ...updated, turn_number: turnNumber };
  }

  _buildResponse(memory, payload, { replayed = false, created = false, previousTurnId = null } = {}) {
    return {
      sid: payload.sid,
      org_id: payload.orgId,
      user_id: payload.userId,
      turn: payload.role,
      turn_number: memory.turn_number || parseTurnNumber(memory.tags || []) || null,
      turn_memory_id: memory.id,
      previous_turn_memory_id: previousTurnId,
      status: (memory.tags || []).find((tag) => String(tag).startsWith('status:'))?.slice(7) || null,
      created,
      idempotency_replayed: replayed,
      project: payload.project,
    };
  }

  async saveChatNew(body, context) {
    const payload = this._normalizePayload(body, context);
    const replay = await this._findReplay(payload);
    if (replay) return this._buildResponse(replay, payload, { replayed: true, created: false });

    const existingTurns = await this._listSessionTurns(payload);
    if (existingTurns.length > 0) {
      throw new EnterpriseChatError('sid already exists; use save_chat_old to append to this chat', 409);
    }

    const created = await this._createTurnMemory(payload, {
      userMessage: payload.role === 'user' ? payload.content : null,
      assistantMessage: payload.role === 'agent' ? payload.content : null,
      turnNumber: 1,
      previousTurnId: null,
      createdVia: 'save_chat_new',
    });

    return this._buildResponse(created, payload, { created: true });
  }

  async saveChatOld(body, context) {
    const payload = this._normalizePayload(body, context, { requireSid: true });
    const replay = await this._findReplay(payload);
    if (replay) return this._buildResponse(replay, payload, { replayed: true, created: false });

    const sessionTurns = await this._listSessionTurns(payload);
    if (sessionTurns.length === 0) {
      throw new EnterpriseChatError('sid not found; use save_chat_new first', 404);
    }

    const latestTurn = sessionTurns[sessionTurns.length - 1];
    const latestStatus = (latestTurn.tags || []).find((tag) => String(tag).startsWith('status:'))?.slice(7) || 'complete';

    if (payload.role === 'user') {
      if (latestStatus === 'pending') {
        throw new EnterpriseChatError('latest turn is still pending an agent response', 409);
      }

      const turnNumber = latestTurn.turn_number + 1;
      if (payload.requestedTurnNumber != null && payload.requestedTurnNumber !== turnNumber) {
        throw new EnterpriseChatError(`turn_number mismatch; expected ${turnNumber}`, 409);
      }

      const created = await this._createTurnMemory(payload, {
        userMessage: payload.content,
        assistantMessage: null,
        turnNumber,
        previousTurnId: latestTurn.id,
        createdVia: 'save_chat_old',
      });
      return this._buildResponse(created, payload, { created: true, previousTurnId: latestTurn.id });
    }

    const pendingCandidates = sessionTurns.filter((memory) => {
      const status = (memory.tags || []).find((tag) => String(tag).startsWith('status:'))?.slice(7) || '';
      return status === 'pending';
    });
    const pendingTurn = payload.requestedTurnNumber == null
      ? pendingCandidates[pendingCandidates.length - 1]
      : pendingCandidates.find((memory) => memory.turn_number === payload.requestedTurnNumber);

    if (!pendingTurn) {
      throw new EnterpriseChatError('no pending user turn found for this sid', 404);
    }

    const { userMessage, assistantMessage } = extractMessages(pendingTurn.content || '');
    if (assistantMessage) {
      throw new EnterpriseChatError('selected turn already has an agent response', 409);
    }

    const updated = await this._updateTurnMemory(pendingTurn, payload, {
      userMessage,
      assistantMessage: payload.content,
      createdVia: 'save_chat_old',
    });

    return this._buildResponse(updated, payload, {
      created: false,
      previousTurnId: sessionTurns.find((memory) => memory.turn_number === updated.turn_number - 1)?.id || null,
    });
  }
}

export { EnterpriseChatError };
