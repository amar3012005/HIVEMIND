#!/usr/bin/env node
/**
 * Snapshot nango_connections.metadata cursors before any destructive op (#28).
 * Writes to /opt/HIVEMIND/.runtime/cursors-YYYYMMDD-HHmm.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  const rows = await prisma.nangoConnection.findMany({
    select: { id: true, userId: true, orgId: true, providerKey: true, metadata: true, connectionId: true },
  });
  const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 13);
  const outDir = process.env.BACKUP_DIR || '/opt/HIVEMIND/.runtime';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `cursors-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, rows }, null, 2));
  console.log(`Wrote ${rows.length} cursor records → ${outPath}`);
  await prisma.$disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
