#!/usr/bin/env node
/**
 * PageIndex Backfill Script — Classify existing memories with embeddings
 *
 * Processes existing memories and assigns them to PageIndex nodes
 * using embedding similarity.
 *
 * Usage:
 *   node core/scripts/pageindex-backfill.js [--concurrency=10] [--dry-run]
 */

import { PrismaClient } from '@prisma/client';
import { PageIndexService } from '../src/services/pageindex-service.js';
import { PageIndexClassifier } from '../src/services/pageindex-classifier.js';

const args = process.argv.slice(2);
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 10;
const dryRun = args.includes('--dry-run');

const prisma = new PrismaClient();
const logger = {
  log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN: ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
};

async function main() {
  logger.log(`Starting PageIndex backfill (concurrency=${concurrency}, dryRun=${dryRun})`);

  const pageindexService = new PageIndexService({ prisma, logger });
  const classifier = new PageIndexClassifier({ prisma, logger });

  // Check if PageIndex is available
  const available = await pageindexService.isAvailable();
  if (!available) {
    logger.log('PageIndex table not found. Run migration first.');
    process.exit(0);
  }

  // Get memories with embeddings (sample 1000 for backfill)
  const allMemories = await prisma.memory.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      embedding: true,
    },
  });

  const memoriesWithEmbeddings = allMemories.filter(m => m.embedding !== null);
  const totalMemories = memoriesWithEmbeddings.length;

  logger.log(`Found ${totalMemories} memories with embeddings`);

  if (totalMemories === 0) {
    logger.log('No memories with embeddings found. Nothing to backfill.');
    process.exit(0);
  }

  let assigned = 0;
  let processed = 0;
  let errors = 0;

  // Process in batches
  const BATCH_SIZE = 50;
  let index = 0;

  while (index < totalMemories) {
    const batchIds = memoriesWithEmbeddings.slice(index, index + BATCH_SIZE).map(m => m.id);

    const memories = await prisma.memory.findMany({
      where: { id: { in: batchIds } },
      select: {
        id: true, userId: true, orgId: true,
        content: true, title: true, tags: true,
        embedding: true, embeddingModel: true,
      },
    });

    if (memories.length === 0) break;

    logger.log(`Processing batch of ${memories.length} memories...`);

    // Process batch with concurrency limit
    const batchPromises = [];
    for (const memory of memories) {
      batchPromises.push(
        classifier.classifyAndAssign(memory)
          .then(result => {
            processed++;
            if (result.assigned) assigned++;
            else errors++;
          })
          .catch(err => {
            logger.warn(`Error processing ${memory.id}: ${err.message}`);
            processed++;
            errors++;
          })
      );

      // Limit concurrency
      if (batchPromises.length >= concurrency) {
        await Promise.all(batchPromises);
        batchPromises.length = 0;
      }
    }

    // Wait for remaining
    await Promise.all(batchPromises);

    logger.log(`Progress: ${processed}/${totalMemories} (${assigned} assigned, ${errors} errors)`);

    index += memories.length;

    // Small delay between batches
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  logger.log(`Backfill complete!`);
  logger.log(`Final: ${processed} processed, ${assigned} assigned, ${errors} errors`);
}

main()
  .catch(err => {
    logger.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
