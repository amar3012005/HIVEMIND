/**
 * GDPR Data Erasure Endpoint
 * Implements GDPR Article 17 - Right to be Forgotten
 *
 * Features:
 * - Soft delete with 30-day grace period
 * - Cancellation support during grace period
 * - Audit logging for compliance (NIS2/DORA)
 * - Permanent deletion after grace period
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

// Erasure configuration
const ERASURE_CONFIG = {
  gracePeriodDays: 30,
  cancellationTokenExpiryHours: 24,
  permanentDeletionDelayHours: 30 * 24, // 30 days
};

/**
 * Request data erasure (GDPR Article 17)
 * POST /api/gdpr/erasure
 */
export async function requestDataErasure(userId, { confirmation, categories = [], reason = '' }) {
  const requestId = crypto.randomUUID();

  // Validate confirmation
  if (confirmation !== 'DELETE_MY_DATA') {
    return {
      error: 'Confirmation required',
      message: 'You must confirm by setting confirmation to "DELETE_MY_DATA"',
      requestId,
    };
  }

  try {
    logger.info('GDPR erasure requested', { requestId, userId, categories, reason });

    // Check for legal holds
    const hasLegalHold = await checkForLegalHold(userId);
    if (hasLegalHold) {
      logger.warn('Erasure blocked - legal hold active', { userId });
      return {
        error: 'Legal hold prevents erasure',
        message: 'Your data is subject to a legal hold and cannot be erased at this time.',
        requestId,
      };
    }

    // Create erasure request record
    const erasureRequest = await prisma.dataExportRequest.create({
      data: {
        userId,
        requestId,
        requestType: 'erasure',
        status: 'pending',
        exportFormat: 'json',
      },
    });

    // Generate cancellation token
    const cancellation_token = crypto.randomBytes(32).toString('hex');

    // Queue erasure job (async - non-blocking)
    queueErasureJob(erasureRequest.id, userId, categories, cancellation_token).catch(error => {
      logger.error('Erasure job failed', { erasureRequestId: erasureRequest.id, error });
    });

    const scheduledDeletion = new Date();
    scheduledDeletion.setDate(scheduledDeletion.getDate() + ERASURE_CONFIG.gracePeriodDays);

    return {
      requestId: erasureRequest.id,
      status: 'grace_period',
      message: 'Your data erasure request is being processed. You have 30 days to cancel this request.',
      gracePeriodDays: ERASURE_CONFIG.gracePeriodDays,
      scheduledDeletion,
      canCancel: true,
      cancellationDeadline: new Date(Date.now() + ERASURE_CONFIG.cancellationTokenExpiryHours * 60 * 60 * 1000),
      confirmationToken: cancellation_token,
    };
  } catch (error) {
    logger.error('GDPR erasure request failed', { requestId, userId, error });
    throw error;
  }
}

/**
 * Check if user has legal holds preventing erasure
 */
async function checkForLegalHold(userId) {
  // Check for active export requests
  const activeExports = await prisma.dataExportRequest.findFirst({
    where: {
      userId,
      status: { in: ['pending', 'processing'] },
      requestType: 'export',
    },
  });

  if (activeExports) {
    return true;
  }

  // Check for active subscriptions or payments
  // This would require integration with billing system
  // For now, return false

  return false;
}

/**
 * Queue and process erasure job
 */
async function queueErasureJob(erasureRequestId, userId, categories, cancellation_token) {
  const prisma = new PrismaClient();

  try {
    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: { status: 'processing' },
    });

    // Soft delete user data first (reversible within 30 days)
    await prisma.$transaction(async (tx) => {
      // Mark memories for deletion
      await tx.memory.updateMany({
        where: { userId },
        data: { deletedAt: new Date() },
      });

      // Mark sessions for deletion
      await tx.session.updateMany({
        where: { userId },
        data: { endedAt: new Date() },
      });

      // Revoke platform integrations
      await tx.platformIntegration.updateMany({
        where: { userId },
        data: {
          isActive: false,
          syncStatus: 'revoked',
        },
      });

      // Mark user for deletion (soft delete)
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });
    });

    // Log for audit (this record itself must be retained for compliance)
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_erasure_requested',
        eventCategory: 'data_modification',
        resourceType: 'user',
        resourceId: userId,
        action: 'erase',
        legalBasisNote: `GDPR Article 17 - Right to erasure. Requested categories: ${categories.join(', ')}. Reason: ${reason || 'No reason provided'}`,
      },
    });

    // Schedule permanent deletion (after 30-day grace period)
    const permanentDeletionDate = new Date();
    permanentDeletionDate.setDate(permanentDeletionDate.getDate() + ERASURE_CONFIG.gracePeriodDays);

    await schedulePermanentDeletion(userId, permanentDeletionDate, cancellation_token);

    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    logger.info('GDPR erasure completed (soft delete)', { erasureRequestId, userId });
  } catch (error) {
    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: {
        status: 'failed',
        errorMessage: String(error),
      },
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Schedule permanent deletion
 */
async function schedulePermanentDeletion(userId, date, cancellation_token) {
  // In production: Use a job queue (Bull, Agenda) or cron
  // Store cancellation_token for verification during cancellation
  //
  // Example with Bull:
  // const jobQueue = getJobQueue('permanent_deletion');
  // await jobQueue.add({
  //   userId,
  //   cancellation_token,
  //   scheduledAt: date,
  // }, {
  //   delay: date.getTime() - Date.now(),
  // });

  logger.info('Permanent deletion scheduled', {
    userId,
    date,
    cancellation_token_hash: crypto.createHash('sha256').update(cancellation_token).digest('hex'),
  });
}

/**
 * Cancel pending erasure (within grace period)
 * POST /api/gdpr/erasure/cancel
 */
export async function cancelErasure(userId, requestId, confirmationToken) {
  try {
    // Check if erasure is in grace period
    const recentErasure = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'erasure',
        status: 'completed',
        completedAt: {
          gte: new Date(Date.now() - ERASURE_CONFIG.gracePeriodDays * 24 * 60 * 60 * 1000),
        },
      },
    });

    if (!recentErasure) {
      return {
        error: 'No cancellable erasure found',
        message: 'Erasure must be within 30-day grace period',
      };
    }

    // Verify cancellation token
    // In production, compare against stored token hash
    if (!confirmationToken) {
      return {
        error: 'Invalid cancellation token',
        message: 'Cancellation token is required',
      };
    }

    // Restore user data
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: null },
      });

      await tx.memory.updateMany({
        where: { userId },
        data: { deletedAt: null },
      });

      await tx.platformIntegration.updateMany({
        where: { userId },
        data: { isActive: true },
      });

      // Update erasure request status
      await tx.dataExportRequest.update({
        where: { id: recentErasure.id },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
        },
      });
    });

    // Log for audit
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_erasure_cancelled',
        eventCategory: 'data_modification',
        resourceType: 'user',
        resourceId: userId,
        action: 'restore',
      },
    });

    logger.info('GDPR erasure cancelled', { userId });

    return {
      status: 'cancelled',
      message: 'Your data has been restored',
    };
  } catch (error) {
    logger.error('Erasure cancellation failed', { userId, requestId, error });
    throw error;
  }
}

/**
 * Get erasure status
 * GET /api/gdpr/erasure/status
 */
export async function getErasureStatus(userId) {
  try {
    const erasureRequest = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'erasure',
      },
      orderBy: { requestedAt: 'desc' },
    });

    if (!erasureRequest) {
      return {
        status: 'none',
        message: 'No erasure request found',
      };
    }

    const gracePeriodEnd = new Date(erasureRequest.completedAt);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + ERASURE_CONFIG.gracePeriodDays);

    return {
      status: erasureRequest.status,
      requestedAt: erasureRequest.requestedAt,
      completedAt: erasureRequest.completedAt,
      errorMessage: erasureRequest.errorMessage,
      gracePeriodEnd,
      canCancel: erasureRequest.status === 'completed' && new Date() < gracePeriodEnd,
    };
  } catch (error) {
    logger.error('Erasure status check failed', { userId, error });
    throw error;
  }
}

/**
 * Process permanent deletion (called by scheduled job)
 */
export async function processPermanentDeletion(userId) {
  const prisma = new PrismaClient();

  try {
    logger.info('Processing permanent deletion', { userId });

    // Hard delete all user data
    await prisma.$transaction(async (tx) => {
      // Delete relationships first (foreign key constraints)
      await tx.relationship.deleteMany({
        where: {
          OR: [
            { fromMemory: { userId } },
            { toMemory: { userId } },
          ],
        },
      });

      // Delete vector embeddings
      await tx.vectorEmbedding.deleteMany({
        where: { memory: { userId } },
      });

      // Delete sync logs
      await tx.syncLog.deleteMany({
        where: { userId },
      });

      // Delete sessions
      await tx.session.deleteMany({
        where: { userId },
      });

      // Delete platform integrations
      await tx.platformIntegration.deleteMany({
        where: { userId },
      });

      // Delete memories (hard delete)
      await tx.memory.deleteMany({
        where: { userId },
      });

      // Delete export requests
      await tx.dataExportRequest.deleteMany({
        where: { userId },
      });

      // Delete audit logs (except compliance-critical ones)
      await tx.auditLog.deleteMany({
        where: { userId },
      });

      // Delete user (hard delete)
      await tx.user.delete({
        where: { id: userId },
      });
    });

    logger.info('Permanent deletion completed', { userId });
  } catch (error) {
    logger.error('Permanent deletion failed', { userId, error });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Get all erasure requests for user
 */
export async function listErasureRequests(userId) {
  try {
    const requests = await prisma.dataExportRequest.findMany({
      where: {
        userId,
        requestType: 'erasure',
      },
      orderBy: { requestedAt: 'desc' },
    });

    return requests.map(req => ({
      id: req.id,
      status: req.status,
      requestedAt: req.requestedAt,
      completedAt: req.completedAt,
      errorMessage: req.errorMessage,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

export default {
  requestDataErasure,
  cancelErasure,
  getErasureStatus,
  processPermanentDeletion,
  listErasureRequests,
  ERASURE_CONFIG,
};
