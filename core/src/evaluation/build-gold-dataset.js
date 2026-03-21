#!/usr/bin/env node
/**
 * Gold Dataset Generator
 *
 * Generates a tenant-specific evaluation dataset from real memories.
 * Reads Prisma DB (read-only) and outputs a JSON file for the evaluator.
 *
 * Usage:
 *   node build-gold-dataset.js [options]
 *
 * Options:
 *   --user-id, -u    User ID (default: HIVEMIND_DEFAULT_USER_ID env)
 *   --org-id         Org ID (default: HIVEMIND_DEFAULT_ORG_ID env)
 *   --curate         Only output top 20-30 strongest queries for review
 *   --output, -o     Output file (default: evaluation-reports/tenant-dataset.generated.json)
 *   --help, -h       Show help
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPrismaClient } from '../db/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, '../../evaluation-reports');

// ── CLI args ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    userId: process.env.HIVEMIND_DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001',
    orgId: process.env.HIVEMIND_DEFAULT_ORG_ID || null,
    curate: false,
    output: path.join(OUTPUT_DIR, 'tenant-dataset.generated.json'),
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user-id': case '-u': opts.userId = args[++i]; break;
      case '--org-id': opts.orgId = args[++i]; break;
      case '--curate': opts.curate = true; break;
      case '--output': case '-o': opts.output = args[++i]; break;
      case '--help': case '-h': opts.help = true; break;
    }
  }
  return opts;
}

// ── Category classification ──────────────────────────────

const CATEGORY_KEYWORDS = {
  technical: ['api', 'prisma', 'qdrant', 'mcp', 'server', 'database', 'migration', 'code', 'bug', 'fix', 'deploy', 'docker', 'redis', 'postgres', 'schema', 'route', 'endpoint', 'embedding', 'vector', 'graph', 'memory', 'ingestion', 'connector', 'bridge', 'sdk'],
  ops: ['deploy', 'ssl', 'docker', 'coolify', 'hetzner', 'container', 'production', 'caddy', 'domain', 'certificate', 'port', 'health', 'restart', 'env', 'volume', 'backup'],
  product: ['connector', 'roadmap', 'supermemory', 'frontend', 'dashboard', 'billing', 'plan', 'feature', 'user', 'onboarding', 'oauth', 'gmail', 'slack', 'github', 'notion'],
  cross_platform: ['antigravity', 'claude', 'vscode', 'mcp-bridge', 'cross-client', 'cross-platform'],
};

function classifyCategory(memory) {
  const text = `${memory.title || ''} ${(memory.tags || []).join(' ')} ${memory.sourcePlatform || ''} ${memory.content?.slice(0, 200) || ''}`.toLowerCase();

  const scores = {};
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = keywords.filter(kw => text.includes(kw)).length;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'technical';
}

// ── Query generation from a memory ───────────────────────

function generateQueryFromMemory(memory) {
  const title = memory.title || '';
  const tags = memory.tags || [];
  const content = memory.content || '';
  const type = memory.memoryType || 'fact';

  // Strategy 1: Use title directly as a question
  if (title && title.length > 10) {
    const titleLower = title.toLowerCase();

    // If title is already a question, use it
    if (titleLower.includes('?')) return title;

    // Convert declarative title to question
    if (titleLower.startsWith('how')) return title + '?';
    if (titleLower.startsWith('what') || titleLower.startsWith('why')) return title + '?';

    // Generic patterns based on memory type
    switch (type) {
      case 'decision':
        return `What was decided about ${title}?`;
      case 'lesson':
        return `What did we learn about ${title}?`;
      case 'goal':
        return `What is the goal for ${title}?`;
      case 'event':
        return `What happened with ${title}?`;
      default:
        return `Tell me about ${title}`;
    }
  }

  // Strategy 2: Use tags to form a query
  if (tags.length >= 2) {
    return `What do we know about ${tags.slice(0, 3).join(' and ')}?`;
  }

  // Strategy 3: Extract first sentence of content
  const firstSentence = content.split(/[.!?\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 15 && firstSentence.length < 100) {
    return `What about: ${firstSentence}?`;
  }

  return null; // Skip this memory — can't form a good query
}

// ── Difficulty assignment ────────────────────────────────

function assignDifficulty(memory, groupSize) {
  const tags = memory.tags || [];
  const hasSpecificTitle = (memory.title || '').length > 20;

  // Easy: specific title, common tags, single result expected
  if (hasSpecificTitle && groupSize === 1) return 'easy';

  // Hard: vague title, many related memories, requires semantic understanding
  if (groupSize >= 3 || tags.length <= 1) return 'hard';

  return 'medium';
}

// ── Scoring for curation ─────────────────────────────────

function scoreQueryQuality(query, memory) {
  let score = 0;

  // Title-based queries are stronger
  if (memory.title && query.includes(memory.title.slice(0, 20))) score += 3;

  // Tag overlap makes ground truth more reliable
  score += Math.min((memory.tags || []).length, 4);

  // Longer content means richer memory
  score += Math.min(Math.floor((memory.content || '').length / 200), 3);

  // Memories with source metadata are more verifiable
  if (memory.sourcePlatform) score += 1;

  // Recent memories are more likely to still be in vector store
  if (memory.createdAt) {
    const ageMs = Date.now() - new Date(memory.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 7) score += 2;
    else if (ageDays < 30) score += 1;
  }

  return score;
}

// ── Group related memories ───────────────────────────────

function groupMemories(memories) {
  const groups = new Map();

  for (const mem of memories) {
    // Group by shared tags (top 2 tags as key)
    const tagKey = (mem.tags || []).sort().slice(0, 2).join(':') || mem.id;
    if (!groups.has(tagKey)) {
      groups.set(tagKey, []);
    }
    groups.get(tagKey).push(mem);
  }

  return groups;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Gold Dataset Generator — builds evaluation queries from real memories.

Usage: node build-gold-dataset.js [options]

Options:
  --user-id, -u    User ID (default: HIVEMIND_DEFAULT_USER_ID env)
  --org-id         Org ID
  --curate         Only output top 20-30 strongest queries
  --output, -o     Output file path
  --help, -h       Show this help
`);
    process.exit(0);
  }

  console.log('');
  console.log('Gold Dataset Generator');
  console.log('======================');
  console.log(`User ID: ${opts.userId}`);
  console.log(`Org ID:  ${opts.orgId || '(any)'}`);
  console.log(`Curate:  ${opts.curate}`);
  console.log(`Output:  ${opts.output}`);
  console.log('');

  // Connect to database
  const prisma = getPrismaClient();
  if (!prisma) {
    console.error('ERROR: Could not connect to database. Set DATABASE_URL.');
    process.exit(1);
  }

  // Fetch all memories for this user
  console.log('Fetching memories...');
  const where = {
    userId: opts.userId,
    deletedAt: null,
    isLatest: true,
  };
  if (opts.orgId) where.orgId = opts.orgId;

  const memories = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      id: true,
      title: true,
      content: true,
      tags: true,
      memoryType: true,
      sourcePlatform: true,
      createdAt: true,
      project: true,
    },
  });

  console.log(`Found ${memories.length} memories`);

  if (memories.length === 0) {
    console.error('No memories found for this user. Nothing to generate.');
    process.exit(1);
  }

  // Group related memories
  const groups = groupMemories(memories);
  console.log(`Grouped into ${groups.size} clusters`);

  // Generate queries
  const candidates = [];

  // Individual memory queries
  for (const mem of memories) {
    const query = generateQueryFromMemory(mem);
    if (!query) continue;

    const category = classifyCategory(mem);
    const groupKey = (mem.tags || []).sort().slice(0, 2).join(':') || mem.id;
    const group = groups.get(groupKey) || [mem];
    const difficulty = assignDifficulty(mem, group.length);

    // Relevant memories: this memory + others in same group
    const relevantIds = group.map(m => m.id);

    const qualityScore = scoreQueryQuality(query, mem);

    candidates.push({
      query,
      relevantMemories: [...new Set(relevantIds)],
      category,
      difficulty,
      description: `Auto-generated from memory: ${(mem.title || mem.content?.slice(0, 50) || mem.id).slice(0, 80)}`,
      tags: mem.tags || [],
      _qualityScore: qualityScore,
      _memoryId: mem.id,
    });
  }

  // Deduplicate queries (same query text)
  const seen = new Set();
  const deduped = candidates.filter(c => {
    const key = c.query.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Generated ${deduped.length} candidate queries`);

  // Sort by quality score
  deduped.sort((a, b) => b._qualityScore - a._qualityScore);

  // Apply curation filter
  let output;
  if (opts.curate) {
    output = deduped.slice(0, 30);
    console.log(`Curated to top ${output.length} queries`);
  } else {
    output = deduped.slice(0, 50);
  }

  // Clean internal fields before export
  const dataset = output.map(({ _qualityScore, _memoryId, ...rest }) => rest);

  // Stats
  const byCategory = {};
  const byDifficulty = {};
  for (const q of dataset) {
    byCategory[q.category] = (byCategory[q.category] || 0) + 1;
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
  }

  console.log('');
  console.log('Dataset Summary:');
  console.log(`  Total queries:  ${dataset.length}`);
  console.log(`  By category:    ${Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`  By difficulty:  ${Object.entries(byDifficulty).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`  Avg relevant:   ${(dataset.reduce((s, q) => s + q.relevantMemories.length, 0) / dataset.length).toFixed(1)}`);

  // Write output
  const outputDir = path.dirname(opts.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(opts.output, JSON.stringify(dataset, null, 2), 'utf-8');
  console.log(`\nDataset written to: ${opts.output}`);
  console.log('');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
