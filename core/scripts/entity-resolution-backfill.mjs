#!/usr/bin/env node
/**
 * Entity-resolution backfill.
 *
 * Sweeps existing memories for a user / org and proposes canonical
 * entities from:
 *   • entity:* tags (preserved from prior LLM extraction)
 *   • email-like strings in content
 *   • salesforce_business_fields when present in source_metadata
 *
 * Auto-merges high-confidence matches; queues fuzzy candidates for
 * review. Idempotent — safe to re-run.
 *
 * Usage:
 *   USER_ID=... ORG_ID=... node core/scripts/entity-resolution-backfill.mjs [--commit]
 *
 * Without --commit prints what it would do.
 */

import { PrismaClient } from '@prisma/client';

const COMMIT = process.argv.includes('--commit');
const USER_ID = process.env.USER_ID;
const ORG_ID = process.env.ORG_ID;
const BATCH = Number(process.env.BACKFILL_BATCH || 200);

if (!USER_ID || !ORG_ID) {
  console.error('USER_ID + ORG_ID env required');
  process.exit(2);
}

const prisma = new PrismaClient();

// Lazy import — production module path differs between local + docker.
async function getResolver() {
  const { EntityResolver } = await import('../src/memory/entity-resolver.js');
  return new EntityResolver({ prisma });
}

function extractEmails(text) {
  if (!text) return [];
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0].toLowerCase());
  return Array.from(out);
}

function extractEntityTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
    .map((t) => t.slice('entity:'.length).replace(/_/g, ' '));
}

(async () => {
  console.log(`backfill start — user=${USER_ID} org=${ORG_ID} commit=${COMMIT}`);
  const resolver = await getResolver();
  let offset = 0;
  let processed = 0;
  let created = 0;
  let linked = 0;
  let review = 0;
  while (true) {
    const memories = await prisma.memory.findMany({
      where: { userId: USER_ID, orgId: ORG_ID, deletedAt: null, isLatest: true },
      include: { sourceMetadata: { select: { metadata: true } } },
      orderBy: { createdAt: 'desc' },
      take: BATCH,
      skip: offset,
    });
    if (memories.length === 0) break;
    for (const m of memories) {
      processed += 1;
      const candidates = [];
      // From SF business fields if present.
      const sm = m.sourceMetadata?.metadata || {};
      const sfFields = sm.salesforce_business_fields || null;
      const sfObjType = sm.salesforce_object_type || null;
      if (sfFields) {
        if (sfObjType === 'Account') {
          candidates.push({
            name: sfFields.Name,
            kind: 'company',
            externalRefs: { salesforce: sm.salesforce_id },
          });
        }
        if (sfObjType === 'Contact') {
          candidates.push({
            name: sfFields.Name || `${sfFields.FirstName || ''} ${sfFields.LastName || ''}`.trim(),
            kind: 'person',
            email: sfFields.Email,
            emailDomain: sm.salesforce_email_domain,
            externalRefs: { salesforce: sm.salesforce_id },
          });
        }
      }
      // From entity:* tags.
      for (const name of extractEntityTags(m.tags)) {
        if (candidates.find((c) => c.name === name)) continue;
        candidates.push({ name, kind: 'person' });
      }
      // From email-like strings in content (cap 3 per memory to avoid spam).
      for (const email of extractEmails(m.content || '').slice(0, 3)) {
        if (candidates.find((c) => c.email === email)) continue;
        candidates.push({ name: email.split('@')[0], kind: 'person', email });
      }
      if (candidates.length === 0) continue;

      if (!COMMIT) {
        console.log(`  ${m.id.slice(0, 8)} → ${candidates.length} candidate(s)`);
        continue;
      }

      try {
        const results = await resolver.resolveAndLink({
          memoryId: m.id,
          candidates,
          organizationId: ORG_ID,
          role: 'subject',
        });
        for (const r of results) {
          if (r.action === 'created') created += 1;
          else if (r.action === 'linked') linked += 1;
          else if (r.action === 'review') review += 1;
        }
      } catch (err) {
        console.warn(`  ✗ ${m.id.slice(0, 8)} resolve failed: ${err.message}`);
      }
      if (processed % 50 === 0) {
        console.log(`  ${processed} processed | created=${created} linked=${linked} review=${review}`);
      }
    }
    offset += memories.length;
    if (memories.length < BATCH) break;
  }
  console.log(`DONE processed=${processed} created=${created} linked=${linked} review=${review}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAIL:', e); await prisma.$disconnect(); process.exit(1); });
