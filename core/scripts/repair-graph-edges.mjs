#!/usr/bin/env node
// ── Graph edge repair: re-validate algorithmic Updates/Contradicts ──────────
// Org-scoped, DRY-RUN BY DEFAULT, idempotent (re-running skips already-
// repaired edges — that is the resumability guarantee). Only destructive
// edge types from algorithmic creators are re-evaluated with the strict
// validator (validateSupersedingEdge); invalid ones are downgraded to
// Mentions (or deleted when a Mentions edge for the pair already exists),
// and memories that were falsely demoted by those edges get is_latest
// restored — but ONLY when nothing else (a remaining valid Updates edge or
// a version chain successor) still supersedes them.
//
// NEVER touched: PartOf edges, memory_evidence_links, source documents,
// segments, memory content, provenance metadata.
//
//   node scripts/repair-graph-edges.mjs --org <org-id>            # dry-run + audit
//   node scripts/repair-graph-edges.mjs --org <org-id> --apply    # write changes
//
// Audit report (before/after, every decision) is printed as JSON on stdout.

import { PrismaClient } from '@prisma/client';
import { validateSupersedingEdge, computeHubEntitySlugs } from '../src/memory/relationship-semantics.js';

const args = process.argv.slice(2);
const orgId = args[args.indexOf('--org') + 1];
const APPLY = args.includes('--apply');
if (!orgId || orgId.startsWith('--')) {
  console.error('usage: repair-graph-edges.mjs --org <org-id> [--apply]');
  process.exit(1);
}

// Algorithmic creators whose destructive edges get re-validated. Explicit
// human/chat classifications are NOT touched.
const ALGO_CREATORS = new Set(['system', 'entity_co_mention_llm', 'conflict-detector', 'turing-reconciliation']);

const prisma = new PrismaClient();
const report = {
  org: orgId,
  mode: APPLY ? 'apply' : 'dry-run',
  started_at: new Date().toISOString(),
  examined: 0,
  kept: [],
  downgraded: [],
  deleted: [],
  restored_is_latest: [],
  restore_skipped: [],
};

try {
  // 1. Candidate edges: destructive types whose BOTH endpoints are in this org.
  const edges = await prisma.relationship.findMany({
    where: {
      type: { in: ['Updates', 'Contradicts'] },
      fromMemory: { orgId },
      toMemory: { orgId },
    },
    include: {
      fromMemory: { select: { id: true, tags: true, content: true } },
      toMemory: { select: { id: true, tags: true, content: true, isLatest: true, memoryType: true } },
    },
  });

  // Hub entities computed over the org's tagged fact corpus (bounded sample).
  const corpus = await prisma.memory.findMany({
    where: { orgId, deletedAt: null },
    select: { tags: true },
    take: 2000,
  });
  const hubSlugs = computeHubEntitySlugs(corpus, 0.3);
  report.hub_slugs = hubSlugs;

  const invalidUpdateTargets = new Set();
  for (const edge of edges) {
    const creator = edge.metadata?.created_by || edge.createdBy || 'system';
    const isAlgo = ALGO_CREATORS.has(creator) || String(creator).startsWith('kb_');
    report.examined += 1;
    if (!isAlgo) {
      report.kept.push({ id: edge.id, type: edge.type, reason: `non-algorithmic creator (${creator})` });
      continue;
    }
    const verdict = validateSupersedingEdge(edge.fromMemory, edge.toMemory, {
      hubSlugs,
      // Updates additionally needs replacement/change evidence: a paraphrase
      // duplicate corroborates (Extends) — it must not supersede.
      requireChangeEvidence: edge.type === 'Updates',
    });
    if (verdict.ok) {
      report.kept.push({ id: edge.id, type: edge.type, reason: `validator ok (${verdict.reason})` });
      continue;
    }
    if (edge.type === 'Updates') invalidUpdateTargets.add(edge.toId);
    // Duplicates keep their corroborating value as Extends; everything else
    // drops to Mentions (shared-entity context only).
    const downgradeType = verdict.reason.startsWith('no-change-evidence') ? 'Extends' : 'Mentions';

    const entry = {
      id: edge.id,
      from: edge.fromId,
      to: edge.toId,
      downgraded_from: edge.type,
      reason: verdict.reason,
      creator,
      from_preview: (edge.fromMemory.content || '').slice(0, 70),
      to_preview: (edge.toMemory.content || '').slice(0, 70),
    };
    entry.downgraded_to = downgradeType;
    const mentionsExists = await prisma.relationship.findFirst({
      where: { fromId: edge.fromId, toId: edge.toId, type: downgradeType },
      select: { id: true },
    });
    if (mentionsExists) {
      report.deleted.push(entry);
      if (APPLY) await prisma.relationship.delete({ where: { id: edge.id } });
    } else {
      report.downgraded.push(entry);
      if (APPLY) {
        await prisma.relationship.update({
          where: { id: edge.id },
          data: {
            type: downgradeType,
            metadata: {
              ...(edge.metadata || {}),
              repair: { downgraded_from: edge.type, reason: verdict.reason, at: new Date().toISOString(), script: 'repair-graph-edges' },
            },
          },
        });
      }
    }
  }

  // 2. Restore falsely demoted memories: targets of the invalidated Updates
  //    edges that are is_latest=false and no longer superseded by anything.
  for (const memoryId of invalidUpdateTargets) {
    const memory = await prisma.memory.findUnique({
      where: { id: memoryId },
      select: { id: true, isLatest: true, content: true },
    });
    if (!memory || memory.isLatest !== false) continue;
    const [remainingUpdate, versionSuccessor] = await Promise.all([
      prisma.relationship.findFirst({ where: { toId: memoryId, type: 'Updates' }, select: { id: true } }),
      prisma.memory.findFirst({ where: { supersedesId: memoryId, deletedAt: null }, select: { id: true } }),
    ]);
    // In apply mode the invalid edges above are already downgraded/deleted, so
    // any remaining Updates edge is a VALID one. In dry-run, simulate by
    // checking against the invalid set.
    const stillSuperseded = APPLY
      ? Boolean(remainingUpdate) || Boolean(versionSuccessor)
      : Boolean(versionSuccessor) ||
        (await prisma.relationship.findMany({ where: { toId: memoryId, type: 'Updates' }, select: { id: true } }))
          .some((r) => !report.downgraded.concat(report.deleted).find((d) => d.id === r.id));
    if (stillSuperseded) {
      report.restore_skipped.push({ id: memoryId, reason: 'still superseded by a valid edge or version chain' });
      continue;
    }
    report.restored_is_latest.push({ id: memoryId, preview: (memory.content || '').slice(0, 70) });
    if (APPLY) await prisma.memory.update({ where: { id: memoryId }, data: { isLatest: true } });
  }

  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
} finally {
  await prisma.$disconnect();
}
