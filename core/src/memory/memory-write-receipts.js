import crypto from 'crypto';

const KEY_LIMIT = 180;

function cleanKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > KEY_LIMIT) return null;
  return key;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function memoryWriteRequestHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function memoryWriteIdempotencyKey(headers, body) {
  return cleanKey(headers?.['x-idempotency-key'] || body?.idempotency_key);
}

export class MemoryWriteReceiptStore {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async scoped(orgId, userId, action) {
    if (typeof this.prisma.$transaction !== 'function') return action(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",
        orgId, userId,
      );
      return action(tx);
    });
  }

  async begin({ orgId, userId, idempotencyKey, requestHash }) {
    return this.scoped(orgId, userId, async (tx) => {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.memory_write_receipts
         (org_id, user_id, idempotency_key, request_hash, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'processing')
       ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING
       RETURNING id, status`,
        orgId, userId, idempotencyKey, requestHash,
      );
      const current = inserted[0] || (await tx.$queryRawUnsafe(
        `SELECT id, status, request_hash, memory_id, response, error_code,
                created_at, updated_at, completed_at
           FROM hivemind.memory_write_receipts
          WHERE org_id = $1::uuid AND user_id = $2::uuid AND idempotency_key = $3
          LIMIT 1`,
        orgId, userId, idempotencyKey,
      ))[0];
      if (!current) throw new Error('memory write receipt could not be acquired');
      if (current.request_hash && current.request_hash !== requestHash) {
        const error = new Error('memory idempotency key does not match the original request');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return { acquired: inserted.length === 1, receipt: current };
    });
  }

  async get({ orgId, userId, idempotencyKey }) {
    return this.scoped(orgId, userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT id, status, request_hash, memory_id, response, error_code,
              created_at, updated_at, completed_at
         FROM hivemind.memory_write_receipts
        WHERE org_id = $1::uuid AND user_id = $2::uuid AND idempotency_key = $3
        LIMIT 1`,
        orgId, userId, idempotencyKey,
      );
      return rows[0] || null;
    });
  }

  async saved({ orgId, userId, idempotencyKey, memoryId, response }) {
    return this.scoped(orgId, userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE hivemind.memory_write_receipts
          SET status = 'saved', memory_id = $4::uuid, response = $5::jsonb,
              error_code = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE org_id = $1::uuid AND user_id = $2::uuid AND idempotency_key = $3
        RETURNING id, status, memory_id, response, created_at, updated_at, completed_at`,
        orgId, userId, idempotencyKey, memoryId, JSON.stringify(response),
      );
      return rows[0];
    });
  }

  async findCommittedMemory({ orgId, userId, idempotencyKey }) {
    return this.scoped(orgId, userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT m.id
         FROM hivemind.memories m
         JOIN hivemind.source_metadata sm ON sm.memory_id = m.id
        WHERE m.org_id = $1::uuid AND m.user_id = $2::uuid
          AND sm.metadata->>'idempotency_key' = $3
          AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC
        LIMIT 1`,
        orgId, userId, idempotencyKey,
      );
      return rows[0]?.id || null;
    });
  }

  async failed({ orgId, userId, idempotencyKey, errorCode }) {
    await this.scoped(orgId, userId, async (tx) => tx.$executeRawUnsafe(
      `UPDATE hivemind.memory_write_receipts
          SET status = 'failed', error_code = $4, completed_at = NOW(), updated_at = NOW()
        WHERE org_id = $1::uuid AND user_id = $2::uuid AND idempotency_key = $3
          AND status = 'processing'`,
      orgId, userId, idempotencyKey, String(errorCode || 'MEMORY_WRITE_FAILED').slice(0, 80),
    ));
  }
}

export function publicMemoryWriteReceipt(row, idempotencyKey) {
  if (!row) return { status: 'not_found', idempotency_key: idempotencyKey };
  return {
    status: row.status,
    receipt_id: row.id,
    idempotency_key: idempotencyKey,
    ...(row.memory_id ? { memory_id: row.memory_id } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.response ? { response: row.response } : {}),
  };
}
