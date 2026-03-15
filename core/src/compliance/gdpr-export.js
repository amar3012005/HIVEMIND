/**
 * GDPR Data Export Endpoint
 * Implements GDPR Article 20 - Right to Data Portability
 *
 * Features:
 * - Asynchronous export processing
 * - 24-hour signed URL expiry
 * - Complete user data export (memories, sessions, integrations)
 * - Audit logging for compliance
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// Export configuration
const EXPORT_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  exportExpiryHours: 24,
  rateLimitPerDay: 2,
};

/**
 * Request data export (GDPR Article 20)
 * POST /api/gdpr/export
 */
export async function requestDataExport(userId, { format = 'json', categories = [] }) {
  const requestId = crypto.randomUUID();

  try {
    logger.info('GDPR export requested', { requestId, userId, format, categories });

    // Check rate limit (max 2 exports per day)
    const recentExports = await prisma.dataExportRequest.findMany({
      where: {
        userId,
        requestType: 'export',
        requestedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    });

    if (recentExports.length >= EXPORT_CONFIG.rateLimitPerDay) {
      logger.warn('GDPR export rate limit exceeded', { userId, recentCount: recentExports.length });
      throw new Error(`Rate limit exceeded. Maximum ${EXPORT_CONFIG.rateLimitPerDay} exports per day.`);
    }

    // Create export request record
    const exportRequest = await prisma.dataExportRequest.create({
      data: {
        userId,
        requestId,
        requestType: 'export',
        status: 'pending',
        exportFormat: format,
      },
    });

    // Queue export job (async - non-blocking)
    queueExportJob(exportRequest.id, userId, format, categories).catch(error => {
      logger.error('Export job failed', { exportRequestId: exportRequest.id, error });
    });

    return {
      requestId: exportRequest.id,
      status: 'processing',
      estimatedCompletion: '5 minutes',
      message: 'Your data export is being prepared. You will receive an email when ready.',
    };
  } catch (error) {
    logger.error('GDPR export request failed', { requestId, userId, error });
    throw error;
  }
}

/**
 * Get export status
 * GET /api/gdpr/export/:id/status
 */
export async function getExportStatus(requestId, userId) {
  try {
    const exportRequest = await prisma.dataExportRequest.findFirst({
      where: { id: requestId, userId },
    });

    if (!exportRequest) {
      return { error: 'Export request not found', requestId };
    }

    if (exportRequest.status === 'pending' || exportRequest.status === 'processing') {
      return {
        status: exportRequest.status,
        message: 'Export is being prepared',
      };
    }

    if (exportRequest.status === 'failed') {
      return {
        status: 'failed',
        error: exportRequest.errorMessage,
      };
    }

    if (exportRequest.status === 'completed') {
      if (!exportRequest.exportUrl) {
        return { error: 'Export URL not available' };
      }

      // Check if URL is still valid (24 hour expiry)
      const urlExpiry = new Date(Date.now() - EXPORT_CONFIG.exportExpiryHours * 60 * 60 * 1000);
      if (exportRequest.completedAt && exportRequest.completedAt < urlExpiry) {
        return {
          status: 'expired',
          message: 'Download link has expired. Please request a new export.',
        };
      }

      const expiresAt = new Date(exportRequest.completedAt.getTime() + EXPORT_CONFIG.exportExpiryHours * 60 * 60 * 1000);

      return {
        status: 'completed',
        downloadUrl: exportRequest.exportUrl,
        expiresAt,
      };
    }

    return { status: exportRequest.status };
  } catch (error) {
    logger.error('Export status check failed', { requestId, error });
    throw error;
  }
}

/**
 * Queue and process export job
 */
async function queueExportJob(exportRequestId, userId, format, categories) {
  const prisma = new PrismaClient();

  try {
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
      data: { status: 'processing' },
    });

    // Collect all user data
    const userData = await collectUserData(userId, categories);

    // Generate export file
    const exportPath = join('/tmp', `export-${exportRequestId}.${format === 'json' ? 'json' : 'csv'}`);
    const writeStream = createWriteStream(exportPath);

    if (format === 'json') {
      await writeJsonExport(userData, writeStream);
    } else {
      await writeCsvExport(userData, writeStream);
    }

    // Compress with gzip
    const compressedPath = exportPath + '.gz';
    const readStream = createReadStream(exportPath);
    const gzipStream = createGzip();
    const compressedWriteStream = createWriteStream(compressedPath);

    await pipeline(readStream, gzipStream, compressedWriteStream);

    // Upload to secure storage and get signed URL
    const exportUrl = await uploadToSecureStorage(compressedPath, exportRequestId, format);

    // Update export request
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
      data: {
        status: 'completed',
        exportUrl,
        completedAt: new Date(),
      },
    });

    // Log for audit (NIS2/DORA compliance)
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_export_completed',
        eventCategory: 'data_access',
        resourceType: 'user',
        resourceId: userId,
        action: 'export',
        newValue: {
          format,
          categories,
          exportUrl,
        },
      },
    });

    logger.info('GDPR export completed', { exportRequestId, userId, format });
  } catch (error) {
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
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
 * Collect all user data for export
 * Excludes secrets and sensitive auth data
 */
async function collectUserData(userId, categories) {
  const prisma = new PrismaClient();

  try {
    const result = {
      exportDate: new Date().toISOString(),
      userId,
      requestType: 'export',
    };

    // Export profile data
    if (categories.length === 0 || categories.includes('profile')) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          timezone: true,
          locale: true,
          createdAt: true,
          lastActiveAt: true,
        },
      });
      result.profile = user;
    }

    // Export memories (without secrets)
    if (categories.length === 0 || categories.includes('memories')) {
      const memories = await prisma.memory.findMany({
        where: {
          userId,
          deletedAt: null,
          exportBlocked: false,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          content: true,
          memoryType: true,
          title: true,
          tags: true,
          sourcePlatform: true,
          sourceSessionId: true,
          sourceMessageId: true,
          sourceUrl: true,
          isLatest: true,
          supersedesId: true,
          strength: true,
          recallCount: true,
          importanceScore: true,
          lastConfirmedAt: true,
          documentDate: true,
          eventDates: true,
          visibility: true,
          sharedWithOrgs: true,
          embeddingModel: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      result.memories = memories;
    }

    // Export sessions
    if (categories.length === 0 || categories.includes('sessions')) {
      const sessions = await prisma.session.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          platformType: true,
          platformSessionId: true,
          title: true,
          messageCount: true,
          tokenCount: true,
          memoriesInjected: true,
          contextWindowUsed: true,
          startedAt: true,
          lastActivityAt: true,
          endedAt: true,
          endReason: true,
          autoCapturedCount: true,
        },
      });
      result.sessions = sessions;
    }

    // Export platform integrations (without secrets)
    if (categories.length === 0 || categories.includes('integrations')) {
      const integrations = await prisma.platformIntegration.findMany({
        where: { userId },
        select: {
          id: true,
          platformType: true,
          platformUserId: true,
          platformDisplayName: true,
          authType: true,
          isActive: true,
          lastSyncedAt: true,
          syncStatus: true,
          consecutiveFailures: true,
          lastErrorMessage: true,
          lastErrorAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      result.integrations = integrations;
    }

    // Export preferences
    if (categories.length === 0 || categories.includes('preferences')) {
      result.preferences = {
        timezone: result.profile?.timezone,
        locale: result.profile?.locale,
      };
    }

    // Export consent history
    if (categories.length === 0 || categories.includes('consent')) {
      const consentHistory = await prisma.auditLog.findMany({
        where: {
          userId,
          eventType: { in: ['consent_granted', 'consent_withdrawn'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      });
      result.consentHistory = consentHistory;
    }

    // Export audit log summary
    if (categories.length === 0 || categories.includes('audit_log')) {
      const auditSummary = await prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          id: true,
          eventType: true,
          eventCategory: true,
          action: true,
          createdAt: true,
          ipAddress: true,
        },
      });
      result.auditLogSummary = auditSummary;
    }

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Write export as JSON
 */
async function writeJsonExport(data, writeStream) {
  return new Promise((resolve, reject) => {
    writeStream.write(JSON.stringify(data, null, 2));
    writeStream.end(() => resolve());
    writeStream.on('error', reject);
  });
}

/**
 * Write export as CSV (simplified)
 */
async function writeCsvExport(data, writeStream) {
  return new Promise(async (resolve, reject) => {
    try {
      const { stringify } = await import('csv-stringify/sync');

      // Flatten data for CSV export
      const csvRows = [];

      // Memories CSV
      if (data.memories) {
        csvRows.push({ sheet: 'memories', data: data.memories });
      }

      // Sessions CSV
      if (data.sessions) {
        csvRows.push({ sheet: 'sessions', data: data.sessions });
      }

      // Integrations CSV
      if (data.integrations) {
        csvRows.push({ sheet: 'integrations', data: data.integrations });
      }

      // Write to stream
      const csv = stringify(csvRows, {
        header: true,
        columns: ['sheet', 'data'],
      });
      writeStream.write(csv);
      writeStream.end(() => resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Upload export to secure storage
 * In production: Upload to S3/GCS with signed URL
 */
async function uploadToSecureStorage(filePath, exportRequestId, format) {
  // In production: Upload to secure object storage (S3, GCS, Azure Blob)
  // with 24-hour signed URL expiry
  //
  // Example AWS S3 implementation:
  // const s3 = new S3Client({ region: 'eu-central-1' });
  // const params = {
  //   Bucket: process.env.EXPORT_BUCKET,
  //   Key: `exports/${exportRequestId}.${format}.gz`,
  //   Body: createReadStream(filePath),
  //   ContentType: 'application/gzip',
  // };
  // await s3.send(new PutObjectCommand(params));
  //
  // const command = new GetObjectCommand({
  //   Bucket: process.env.EXPORT_BUCKET,
  //   Key: `exports/${exportRequestId}.${format}.gz`,
  // });
  // return getSignedUrl(s3, command, { expiresIn: 24 * 60 * 60 });

  // For development/local: Return placeholder URL
  return `https://exports.hivemind.io/${exportRequestId}.${format}.gz`;
}

/**
 * Export all user data in portable format
 * GET /api/gdpr/export/:id
 */
export async function exportUserData(userId, requestId) {
  const prisma = new PrismaClient();

  try {
    const exportRequest = await prisma.dataExportRequest.findFirst({
      where: { id: requestId, userId },
    });

    if (!exportRequest) {
      throw new Error('Export request not found');
    }

    if (exportRequest.status !== 'completed') {
      throw new Error('Export not yet completed');
    }

    if (!exportRequest.exportUrl) {
      throw new Error('Export URL not available');
    }

    return {
      requestId: exportRequest.id,
      status: 'completed',
      downloadUrl: exportRequest.exportUrl,
      expiresAt: new Date(exportRequest.completedAt.getTime() + EXPORT_CONFIG.exportExpiryHours * 60 * 60 * 1000),
    };
  } finally {
    await prisma.$disconnect();
  }
}

export default {
  requestDataExport,
  getExportStatus,
  collectUserData,
  uploadToSecureStorage,
  exportUserData,
  EXPORT_CONFIG,
};
