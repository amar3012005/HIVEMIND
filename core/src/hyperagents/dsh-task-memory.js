import { createHash } from 'node:crypto';

// Only the signed runner submits response-completion receipts. Model saves
// remain learning/decision/handoff writes through the existing agent contract.
export function dshTaskMemory(input) {
  const context = input.context;
  const keys = ['source', 'completionScope', 'sessionId', 'turn', 'ownerName', 'requestedAt', 'completedAt', 'requestSeqs', 'responseSeq', 'completionSeq', 'toolReceipts'];
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!context || Array.isArray(context) || typeof context !== 'object'
    || Object.keys(context).some(key => !keys.includes(key))
    || context.source !== 'dsh-turn' || context.completionScope !== 'response'
    || !/^session-[0-9a-f-]{36}$/i.test(context.sessionId || '')
    || !integer(context.turn) || context.turn < 1
    || typeof context.ownerName !== 'string' || !context.ownerName.trim() || context.ownerName.length > 180
    || !integer(context.responseSeq) || !integer(context.completionSeq) || context.responseSeq >= context.completionSeq
    || !Array.isArray(context.requestSeqs) || !context.requestSeqs.length || context.requestSeqs.length > 64
    || context.requestSeqs.some(seq => !integer(seq) || seq >= context.responseSeq)
    || !Array.isArray(context.toolReceipts) || context.toolReceipts.length > 16) throw new Error('invalid_task_memory_receipt');
  for (const key of ['requestedAt', 'completedAt']) {
    if (typeof context[key] !== 'string' || !Number.isFinite(Date.parse(context[key])) || new Date(context[key]).toISOString() !== context[key]) throw new Error('invalid_task_memory_timestamp');
  }
  if (Date.parse(context.completedAt) < Date.parse(context.requestedAt)) throw new Error('invalid_task_memory_timestamp');
  for (const receipt of context.toolReceipts) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).some(key => !['name', 'callId', 'resultSeq', 'isError'].includes(key))
      || typeof receipt.name !== 'string' || !receipt.name || receipt.name.length > 180
      || typeof receipt.callId !== 'string' || !receipt.callId || receipt.callId.length > 180
      || !integer(receipt.resultSeq) || receipt.resultSeq >= context.completionSeq
      || typeof receipt.isError !== 'boolean') throw new Error('invalid_task_memory_tool_receipt');
  }
  const key = `dsh-task:${context.sessionId}:${context.turn}:${context.completionSeq}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const runId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  if (input.idempotency_key !== key || input.run_id !== runId) throw new Error('invalid_task_memory_identity');
  return { ...input, kind: 'task_status', status: 'completed' };
}
