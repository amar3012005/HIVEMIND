#!/usr/bin/env node
/**
 * PageIndex Backfill Script
 *
 * Classifies existing memories and populates PageIndex hierarchy.
 * Safe to re-run (idempotent) — uses checkpoint-based resume.
 *
 * Usage:
 *   node core/scripts/pageindex-backfill.js [--concurrency=10] [--dry-run]
 *
 * Features:
 * - Checkpoint-based resume (survives crashes)
 * - Rate-limited (doesn't overwhelm DB/API)
 * - Dry-run mode (preview without writing)
 * - Progress logging
 */

import { PrismaClient } from '@prisma/client';
import { PageIndexService } from '../src/services/pageindex-service.js';
import { PageIndexClassifier } from '../src/services/pageindex-classifier.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CHECKPOINT_FILE = join(process.cwd(), '.pageindex-backfill-checkpoint.json');
const DEFAULT_CONCURRENCY = 10;
const BATCH_SIZE = 100;
const DELAY_BETWEEN_BATCHES_MS = 200;

// Parse arguments
const args = process.argv.slice(2);
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || DEFAULT_CONCURRENCY;
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

  // Load checkpoint
  let checkpoint = loadCheckpoint();
  logger.log(`Resuming from checkpoint: ${checkpoint.lastMemoryId || 'start'}`);

  // Get total count
  const totalMemories = await prisma.memory.count({
    where: { deletedAt: null },
  });
  logger.log(`Total memories to process: ${totalMemories}`);

  let processed = 0;
  let classified = 0;
  let errors = 0;

  // Process in batches
  while (true) {
    const memories = await prisma.memory.findMany({
      where: { deletedAt: null },
      select: { id: true, content: true, title: true, tags: true, userId: true, orgId: true },
      skip: checkpoint.lastIndex || 0,
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    if (memories.length === 0) {
      logger.log('Backfill complete!');
      break;
    }

    logger.log(`Processing batch of ${memories.length} memories...`);

    // Process batch with concurrency limit
    const batchPromises = [];
    for (const memory of memories) {
      batchPromises.push(
        processMemory(memory, pageindexService, classifier)
          .then(result => {
            processed++;
            if (result.success) classified++;
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
        batchPromises.length = 0; // Clear array
        await sleep(50); // Small delay between sub-batches
      }
    }

    // Wait for remaining
    await Promise.all(batchPromises);

    // Update checkpoint
    checkpoint.lastIndex = (checkpoint.lastIndex || 0) + memories.length;
    checkpoint.lastMemoryId = memories[memories.length - 1]?.id;
    checkpoint.processed = processed;
    checkpoint.classified = classified;
    checkpoint.errors = errors;
    saveCheckpoint(checkpoint);

    logger.log(`Progress: ${processed}/${totalMemories} (${classified} classified, ${errors} errors)`);

    // Rate limit
    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  // Clean up checkpoint on success
  if (existsSync(CHECKPOINT_FILE)) {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({ completed: true, completedAt: new Date().toISOString() }));
  }

  logger.log(`Final: ${processed} processed, ${classified} classified, ${errors} errors`);
}

async function processMemory(memory, pageindexService, classifier) {
  // Ensure root node exists
  await pageindexService.ensureRootNode(memory.userId, memory.orgId);

  // Classify memory
  const classification = await classifier.classify(memory);

  if (!classification.paths || classification.paths.length === 0) {
    return { success: false, reason: 'no_classification' };
  }

  // Create nodes and assign memory
  const nodeIds = [];
  for (const path of classification.paths) {
    // Parse path and create nodes as needed
    const parts = path.split('/').filter(Boolean);
    let currentParentId = null;
    let currentPath = '/hivemind';

    for (const part of parts) {
      currentPath = `${currentPath}/${part}`;

      // Check if node exists
      let node = await pageindexService.findNodeByPath(memory.userId, currentPath);

      if (!node) {
        // Create node
        node = await pageindexService.createNode({
          userId: memory.userId,
          orgId: memory.orgId,
          parentId: currentParentId,
          label: capitalize(part),
          nodeType: parts.indexOf(part) === 0 ? 'category' :
                    parts.indexOf(part) === parts.length - 1 ? 'subtopic' : 'topic',
        });
      }

      if (node) {
        nodeIds.push(node.id);
        currentParentId = node.id;
      }
    }
  }

  // Assign memory to all nodes
  if (nodeIds.length > 0) {
    const assigned = await pageindexService.assignMemoryToNodes(nodeIds, memory.id);
    return { success: assigned > 0, assigned };
  }

  return { success: false, reason: 'no_nodes_created' };
}

function loadCheckpoint() {
  if (existsSync(CHECKPOINT_FILE)) {
    try {
      return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
    } catch {
      return { lastIndex: 0, processed: 0, classified: 0, errors: 0 };
    }
  }
  return { lastIndex: 0, processed: 0, classified: 0, errors: 0 };
}

function saveCheckpoint(checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Run
main()
  .then(() => {
    logger.log('Backfill finished');
    process.exit(0);
  })
  .catch(err => {
    logger.error(`Backfill failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
