// Re-title memory facts whose TITLE is letter-spaced OCR furniture (e.g.
// "S O L V I S G E M E I N W O H L - B I L A N Z") but whose CONTENT is real.
// Memory-layer only — derives a clean title from the fact's content; never
// deletes the fact, never touches the evidence (knowledge_segments) layer.
// The forward fix (isGarbageTitle guard in document-first-ingestion.js) stops
// new ones; this cleans the existing corpus.
//
// Run IN-CONTAINER (needs @prisma/client from /app):
//   docker exec hm-core node /app/scripts/retitle-garbage-titles.mjs            # DRY (default)
//   docker exec hm-core sh -c 'RETITLE_COMMIT=1 node /app/scripts/retitle-garbage-titles.mjs'
// Scope: pass project ids as args, else defaults to the two Solvis projects.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.env.RETITLE_COMMIT === '1';
const PIDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['370ff127-34da-4822-853a-42de3e39dcbf', '0d8279b3-f7b0-46c6-9415-cebb52f7cc7c'];

// Identical logic to document-first-ingestion.js (keep in sync).
function isGarbageTitle(t) {
  if (!t || typeof t !== 'string') return true;
  const s = t.trim();
  if (s.length < 2) return true;
  const toks = s.split(/\s+/).filter(Boolean);
  if (toks.length >= 5) {
    const singles = toks.filter((w) => w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length <= 1).length;
    if (singles / toks.length >= 0.6) return true;
  }
  return false;
}
function cleanTitleFrom(text, max = 80) {
  const raw = (text || '').trim();
  const segs = raw.split(/\n|(?<=[.!?])\s/).map((s) => s.trim()).filter(Boolean);
  const first = segs.find((s) => !isGarbageTitle(s)) || segs[0] || '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const atWord = cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max);
  return `${atWord.trim()}…`;
}

const rows = await prisma.$queryRawUnsafe(
  `SELECT m.id, m.title, m.content
   FROM hivemind.memories m JOIN hivemind.memory_projects mp ON mp.memory_id = m.id
   WHERE mp.project_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
   AND m.title ~ '([A-Za-zÀ-ÿ][ ]){5,}'`,
  PIDS,
);

let fixed = 0, skipped = 0;
for (const r of rows) {
  if (!isGarbageTitle(r.title)) continue; // regex is a coarse prefilter; confirm
  const nt = cleanTitleFrom(r.content, 80);
  if (!nt || isGarbageTitle(nt)) {
    console.log(`SKIP ${r.id.slice(0, 8)} — no clean title derivable from content`);
    skipped++;
    continue;
  }
  console.log(`${COMMIT ? 'RETITLE' : 'would-retitle'} ${r.id.slice(0, 8)}: ${JSON.stringify(r.title.slice(0, 34))} -> ${JSON.stringify(nt)}`);
  if (COMMIT) {
    await prisma.memory.update({ where: { id: r.id }, data: { title: nt.slice(0, 500) } });
    fixed++;
  }
}
console.log(`\n[retitle] matched=${rows.length} ${COMMIT ? `fixed=${fixed}` : '(DRY — set RETITLE_COMMIT=1 to apply)'} skipped=${skipped}`);
await prisma.$disconnect();
