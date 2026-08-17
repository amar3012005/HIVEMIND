#!/usr/bin/env node
import { getCentralPrismaClient } from '../src/db/prisma.js';
import { isSealedOutboxPayload, sealOutboxPayload } from '../src/memory/outbox-crypto.js';

const prisma = getCentralPrismaClient();
const BATCH = Math.max(1, Math.min(500, Number(process.env.OUTBOX_MIGRATION_BATCH || 100)));
let sealed = 0;
let cursor = null;

try {
  // Acknowledged deliveries need no replay content. Redaction is idempotent and
  // intentionally retains the row for aggregate delivery telemetry.
  const redacted = await prisma.memoryOutbox.updateMany({
    where: { status: 'acked' },
    data: { payload: { v: 1, redacted: true } },
  });

  for (;;) {
    const rows = await prisma.memoryOutbox.findMany({
      where: { status: { in: ['pending', 'dead'] } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, payload: true },
    });
    if (!rows.length) break;
    const plaintext = rows.filter((row) => !isSealedOutboxPayload(row.payload) && row.payload?.redacted !== true);
    for (const row of plaintext) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.memoryOutbox.update({
        where: { id: row.id },
        data: { payload: sealOutboxPayload(row.payload, { requireEncryption: true }) },
      });
      sealed += 1;
    }
    cursor = rows.at(-1).id;
    if (rows.length < BATCH) break;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, acked_redacted: redacted.count, pending_dead_sealed: sealed })}\n`);
} finally {
  await prisma.$disconnect();
}
