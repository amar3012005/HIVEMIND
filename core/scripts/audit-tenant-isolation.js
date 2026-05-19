#!/usr/bin/env node
/**
 * Static-grep audit for tenant scoping (#27). Flags Prisma calls without
 * org_id filter on tenant-scoped models. Run in CI.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || './src';
const TENANT_MODELS = [
  'memory', 'knowledgeDocument', 'knowledgeSegment', 'sourceArtifact',
  'entity', 'entityMention', 'topicState', 'nangoConnection',
  'inboundWebhookSubscription', 'inboundWebhookEvent', 'memoryEvidenceLink',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '.next', 'dist', 'build'].includes(e.name)) walk(p, out);
    } else if (e.name.endsWith('.js') || e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const model of TENANT_MODELS) {
    // Look for prisma.<model>.findMany|findFirst|update|delete without orgId in same block
    const re = new RegExp(`prisma\\.${model}\\.(findMany|findFirst|findUnique|updateMany|deleteMany)\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const lineNum = text.slice(0, m.index).split('\n').length;
      const ctx = lines.slice(lineNum - 1, lineNum + 8).join('\n');
      const hasOrgId = /\borgId\b|\borg_id\b/.test(ctx);
      // Skip system-wide reads we expect (admin endpoints, scanners)
      const isAdmin = /admin|scanner|cron|migration|seed/i.test(file);
      if (!hasOrgId && !isAdmin) {
        findings.push({ file, line: lineNum, model, ctx: ctx.slice(0, 300) });
      }
    }
  }
}

if (findings.length === 0) {
  console.log('✅ Tenant isolation audit: clean');
  process.exit(0);
}
console.log(`⚠️  ${findings.length} potential tenant-scope gaps found:\n`);
for (const f of findings.slice(0, 50)) {
  console.log(`  ${f.file}:${f.line}  prisma.${f.model}.*`);
}
if (findings.length > 50) console.log(`  ...and ${findings.length - 50} more`);
process.exit(1);
