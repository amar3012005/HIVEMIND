/**
 * Batch Processor Skill
 * Production-grade batch ingestion with retry and exponential backoff
 */

import { BaseSkill } from '../../core/base-skill.js';

export default class BatchProcessorSkill extends BaseSkill {
  constructor(options) {
    super(options);
    this.queue = [];
    this.processing = false;
    this.deadLetterQueue = [];
    this.stats = {
      totalProcessed: 0,
      totalFailed: 0,
      totalRetried: 0
    };
  }

  async initialize() {
    this.info('Initializing Batch Processor skill');
    await super.initialize();

    // Start processing loop
    this.startProcessingLoop();
  }

  async destroy() {
    // Flush remaining items
    await this.flushQueue();
    await super.destroy();
  }

  /**
   * Process a batch of items
   */
  async processBatch(args = {}) {
    const {
      items,
      batchSize = this.getConfig('batchSize'),
      parallel = this.getConfig('parallel')
    } = args;

    if (!items || !Array.isArray(items)) {
      throw new Error('items array is required');
    }

    this.info('Processing batch', { itemCount: items.length, batchSize });

    // Add to queue with metadata
    for (const item of items) {
      this.queue.push({
        ...item,
        _meta: {
          attempts: 0,
          addedAt: Date.now(),
          nextAttempt: Date.now()
        }
      });
    }

    // Trigger processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return {
      queued: items.length,
      queueSize: this.queue.length,
      estimatedTime: this.estimateTime(items.length, batchSize)
    };
  }

  /**
   * Process the queue
   */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    const batchSize = this.getConfig('batchSize');
    const parallel = this.getConfig('parallel');

    while (this.queue.length > 0) {
      // Get items ready for processing
      const now = Date.now();
      const readyItems = this.queue
        .filter(item => item._meta.nextAttempt <= now)
        .slice(0, batchSize);

      if (readyItems.length === 0) {
        // Wait a bit and check again
        await this.sleep(100);
        continue;
      }

      // Remove from queue
      for (const item of readyItems) {
        const index = this.queue.indexOf(item);
        if (index > -1) this.queue.splice(index, 1);
      }

      try {
        if (parallel) {
          await this.processParallel(readyItems);
        } else {
          await this.processSequential(readyItems);
        }
      } catch (err) {
        this.error('Batch processing error', err);
      }
    }

    this.processing = false;
  }

  /**
   * Process items in parallel
   */
  async processParallel(items) {
    const results = await Promise.allSettled(
      items.map(item => this.processItem(item))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        await this.handleFailure(items[i], result.reason);
      } else {
        this.stats.totalProcessed++;
      }
    }
  }

  /**
   * Process items sequentially
   */
  async processSequential(items) {
    for (const item of items) {
      try {
        await this.processItem(item);
        this.stats.totalProcessed++;
      } catch (err) {
        await this.handleFailure(item, err);
      }
    }
  }

  /**
   * Process a single item
   */
  async processItem(item) {
    const { _meta, ...data } = item;

    // Store to memory
    // This would connect to actual memory service
    const result = await this.callMemoryService('store', data);

    return result;
  }

  /**
   * Handle failed item with retry
   */
  async handleFailure(item, error) {
    const maxRetries = this.getConfig('maxRetries');
    const attempts = item._meta.attempts + 1;

    if (attempts < maxRetries) {
      // Retry with exponential backoff
      item._meta.attempts = attempts;
      item._meta.nextAttempt = Date.now() + this.calculateDelay(attempts);
      item._meta.lastError = error.message;

      this.queue.push(item);
      this.stats.totalRetried++;

      this.warn(`Retrying item (attempt ${attempts})`, {
        itemId: item.id,
        error: error.message,
        nextAttempt: new Date(item._meta.nextAttempt).toISOString()
      });
    } else {
      // Move to dead letter queue
      this.deadLetterQueue.push({
        ...item,
        _meta: {
          ...item._meta,
          failedAt: Date.now(),
          finalError: error.message
        }
      });
      this.stats.totalFailed++;

      this.error('Item failed permanently, moved to DLQ', {
        itemId: item.id,
        attempts,
        error: error.message
      });
    }
  }

  /**
   * Calculate exponential backoff delay
   */
  calculateDelay(attempt) {
    const initialDelay = this.getConfig('initialDelay');
    const maxDelay = this.getConfig('maxDelay');
    const backoffFactor = this.getConfig('backoffFactor');

    const delay = initialDelay * Math.pow(backoffFactor, attempt - 1);
    // Add jitter
    return Math.min(delay, maxDelay) * (0.5 + Math.random());
  }

  /**
   * Retry failed items from DLQ
   */
  async retryFailed(args = {}) {
    const { maxItems = 10 } = args;

    if (this.deadLetterQueue.length === 0) {
      return { retried: 0, message: 'Dead letter queue is empty' };
    }

    const itemsToRetry = this.deadLetterQueue.splice(0, maxItems);

    // Reset retry count and add back to queue
    for (const item of itemsToRetry) {
      item._meta.attempts = 0;
      item._meta.nextAttempt = Date.now();
      delete item._meta.finalError;
      delete item._meta.failedAt;
      this.queue.push(item);
    }

    // Trigger processing
    this.processQueue();

    return {
      retried: itemsToRetry.length,
      dlqRemaining: this.deadLetterQueue.length
    };
  }

  /**
   * Get current queue status
   */
  async getQueueStatus() {
    return {
      queue: {
        size: this.queue.length,
        ready: this.queue.filter(i => i._meta.nextAttempt <= Date.now()).length,
        pending: this.queue.filter(i => i._meta.nextAttempt > Date.now()).length
      },
      deadLetterQueue: {
        size: this.deadLetterQueue.length,
        oldest: this.deadLetterQueue[0]?._meta.failedAt || null
      },
      processing: this.processing,
      stats: { ...this.stats },
      config: {
        batchSize: this.getConfig('batchSize'),
        maxRetries: this.getConfig('maxRetries')
      }
    };
  }

  /**
   * Configure batch processing
   */
  async configureBatch(args = {}) {
    const allowedKeys = ['batchSize', 'maxRetries', 'initialDelay', 'maxDelay', 'backoffFactor', 'parallel'];

    for (const [key, value] of Object.entries(args)) {
      if (allowedKeys.includes(key)) {
        this.setConfig(key, value);
      }
    }

    return {
      message: 'Configuration updated',
      config: allowedKeys.reduce((acc, key) => {
        acc[key] = this.getConfig(key);
        return acc;
      }, {})
    };
  }

  /**
   * Flush queue (process all remaining items immediately)
   */
  async flushQueue() {
    const before = this.queue.length;

    // Set all items to ready now
    for (const item of this.queue) {
      item._meta.nextAttempt = Date.now();
    }

    // Process immediately
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.getConfig('batchSize'));
      await this.processSequential(batch);
    }

    return {
      flushed: before,
      remaining: this.queue.length,
      processed: this.stats.totalProcessed
    };
  }

  /**
   * Get dead letter queue contents
   */
  async getDeadLetterQueue(args = {}) {
    const { limit = 50, offset = 0 } = args;

    return {
      total: this.deadLetterQueue.length,
      items: this.deadLetterQueue.slice(offset, offset + limit).map(item => ({
        id: item.id,
        content: item.content?.slice(0, 200),
        attempts: item._meta.attempts,
        failedAt: item._meta.failedAt,
        error: item._meta.finalError
      }))
    };
  }

  /**
   * Estimate processing time
   */
  estimateTime(itemCount, batchSize) {
    const avgBatchTime = 500; // ms
    const batches = Math.ceil(itemCount / batchSize);
    return batches * avgBatchTime;
  }

  /**
   * Start background processing loop
   */
  startProcessingLoop() {
    // Periodic check for new items
    setInterval(() => {
      if (this.queue.length > 0 && !this.processing) {
        this.processQueue();
      }
    }, 1000);
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Call memory service (placeholder)
   */
  async callMemoryService(method, data) {
    // This would connect to actual memory service
    return { success: true, id: `mem_${Date.now()}` };
  }
}
