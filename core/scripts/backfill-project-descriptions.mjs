#!/usr/bin/env node
/**
 * One-time backfill: give every project a description.
 *
 * For each project with a null/blank description, sample its memories (via the
 * memory_projects join + the legacy projectId FK), LLM-summarize into a 1-2
 * sentence description, and persist it. Idempotent — projects that already have
 * a non-empty description are skipped.
 *
 * Reuses the canonical LLM gateway (chatCompletion) — no new infra.
 *
 *   docker exec hm-core node /app/scripts/backfill-project-descriptions.mjs           # all orgs
 *   docker exec hm-core node /app/scripts/backfill-project-descriptions.mjs --org <id> # one org
 *   DRY_RUN=1 docker exec hm-core node /app/scripts/backfill-project-descriptions.mjs  # preview, no writes
 */
import { getPrismaClient } from '../src/db/prisma.js';
import { chatCompletion } from '../src/knowledge/enterprise/litellm-client.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const MODEL = process.env.PROJECT_SUMMARY_MODEL || process.env.SUMMARY_MODEL || 'openai/gpt-oss-20b';
const orgArgIdx = process.argv.indexOf('--org');
const ORG_FILTER = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : null;

const isBlank = (s) => !s || !String(s).trim();

async function sampleMemories(prisma, projectId, orgId) {
  // Memories linked via the M:N join OR the legacy projectId FK.
  // orgId is required by the tenant-isolation guard on Memory queries.
  const rows = await prisma.memory.findMany({
    where: {
      orgId,
      deletedAt: null,
      OR: [{ projectId }, { memoryProjects: { some: { projectId } } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { title: true, content: true, memoryType: true },
  }).catch((e) => { console.warn(`[backfill] sample failed for ${projectId}: ${e.message}`); return []; });
  return rows;
}

function buildPrompt(project, mems) {
  const lines = mems.map((m, i) => {
    const body = (m.title || m.content || '').replace(/\s+/g, ' ').slice(0, 220);
    return `${i + 1}. [${m.memoryType || 'note'}] ${body}`;
  }).join('\n');
  return [
    { role: 'system', content: 'You write crisp one-to-two sentence descriptions of a knowledge-base "project" (a sub-workspace of an org). Describe what the project is ABOUT — its theme/purpose — based only on the sample memories. No preamble, no quotes, max 240 chars.' },
    { role: 'user', content: `Project name: ${project.name}\nSlug: ${project.slug}\n\nSample memories:\n${lines || '(no memories yet)'}\n\nWrite the project description:` },
  ];
}

async function main() {
  const prisma = getPrismaClient();
  const where = { description: null };
  if (ORG_FILTER) where.orgId = ORG_FILTER;
  // Catch both NULL and empty-string descriptions.
  const projects = await prisma.project.findMany({
    where: ORG_FILTER ? { orgId: ORG_FILTER } : {},
    select: { id: true, orgId: true, name: true, slug: true, description: true },
    orderBy: { createdAt: 'asc' },
  });
  const needs = projects.filter((p) => isBlank(p.description));
  console.log(`[backfill] ${needs.length}/${projects.length} project(s) need a description${ORG_FILTER ? ` (org ${ORG_FILTER})` : ''}. DRY_RUN=${DRY_RUN}`);

  let done = 0, skipped = 0, failed = 0;
  for (const p of needs) {
    try {
      const mems = await sampleMemories(prisma, p.id, p.orgId);
      let desc;
      const fallback = `Project "${p.name}" — ${mems.length} memor${mems.length === 1 ? 'y' : 'ies'}; scope for ${p.name}-related knowledge.`;
      if (mems.length === 0) {
        desc = fallback;
      } else {
        try {
          const raw = await chatCompletion({ messages: buildPrompt(p, mems), model: MODEL, temperature: 0.2, max_tokens: 160 });
          desc = String(typeof raw === 'string' ? raw : (raw?.content || '')).trim().replace(/^["']|["']$/g, '').slice(0, 240);
        } catch (e) { console.warn(`[backfill] LLM failed for ${p.name}: ${e.message}`); }
        if (!desc) desc = fallback; // never leave a project description-less
      }
      if (DRY_RUN) {
        console.log(`[dry] ${p.name} (${p.id}) → ${desc}`);
      } else {
        await prisma.project.update({ where: { id: p.id }, data: { description: desc } });
        console.log(`[ok]  ${p.name} (${p.id}) → ${desc}`);
      }
      done++;
    } catch (e) {
      failed++;
      console.warn(`[backfill] FAILED ${p.name} (${p.id}): ${e.message}`);
    }
  }
  console.log(`[backfill] complete. updated=${done} failed=${failed} (already-described skipped=${projects.length - needs.length})`);
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('[backfill] crashed:', e); process.exit(1); });
