const STATUSES = new Set(['prepared', 'approved', 'executing', 'completed', 'cancelled']);
const SCOPES = new Set(['personal', 'organization', 'project']);

function text(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeSaveIdempotencyKey(value) {
  return text(value, 200);
}

export async function getSaveOperation(prisma, { orgId, userId, idempotencyKey }) {
  const key = normalizeSaveIdempotencyKey(idempotencyKey);
  if (!orgId || !userId || !key) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT operation_id, status, destination_scope, request, receipt, idempotency_key, updated_at
       FROM hivemind.memory_save_operations
      WHERE org_id = $1::uuid AND user_id = $2::uuid AND idempotency_key = $3
      LIMIT 1`,
    orgId, userId, key,
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    operation_id: row.operation_id,
    status: row.status,
    destination_scope: row.destination_scope || null,
    request: asObject(row.request),
    receipt: row.receipt ? asObject(row.receipt) : null,
    idempotency_key: row.idempotency_key,
    updated_at: row.updated_at,
  };
}

export async function upsertSaveOperation(prisma, input = {}) {
  const orgId = input.orgId;
  const userId = input.userId;
  const idempotencyKey = normalizeSaveIdempotencyKey(input.idempotencyKey);
  const operationId = text(input.operationId, 200);
  const status = text(input.status, 32);
  if (!orgId || !userId || !idempotencyKey || !operationId || !STATUSES.has(status)) {
    throw new Error('invalid_save_operation');
  }
  const destination = input.destinationScope && SCOPES.has(input.destinationScope)
    ? input.destinationScope
    : null;
  const request = JSON.stringify(asObject(input.request));
  const receipt = input.receipt ? JSON.stringify(asObject(input.receipt)) : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.memory_save_operations
       (org_id, user_id, idempotency_key, operation_id, status, destination_scope, request, receipt)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (org_id, idempotency_key) DO UPDATE SET
       operation_id = EXCLUDED.operation_id,
       status = EXCLUDED.status,
       destination_scope = COALESCE(EXCLUDED.destination_scope, hivemind.memory_save_operations.destination_scope),
       request = EXCLUDED.request,
       receipt = COALESCE(EXCLUDED.receipt, hivemind.memory_save_operations.receipt),
       updated_at = now()`,
    orgId, userId, idempotencyKey, operationId, status, destination, request, receipt,
  );
  return getSaveOperation(prisma, { orgId, userId, idempotencyKey });
}

export function publicSaveStatus(row) {
  if (!row) return { status: 'not_found' };
  return {
    status: row.status,
    operation: 'save_status',
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    destination_scope: row.destination_scope,
    receipt: row.receipt,
    replayed: row.status === 'completed',
  };
}
