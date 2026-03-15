/**
 * GDPR Data Inventory Service
 * Implements GDPR Article 30 - Records of Processing Activities
 *
 * Features:
 * - Complete data inventory for all users
 * - Processing purpose mapping
 * - Legal basis tracking
 * - Data retention policies
 * - Export for regulatory audit
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

// GDPR Article 30 required fields for records of processing
const ARTICLE_30_FIELDS = [
  'processing_purpose',
  'data_categories',
  'data_subjects',
  'data_recipients',
  'international_transfers',
  'retention_period',
  'legal_basis',
  'security_measures',
];

/**
 * Get data inventory for a user (Article 30 compliance)
 */
export async function getUserDataInventory(userId) {
  try {
    const inventory = {
      userId,
      generatedAt: new Date().toISOString(),
      processingActivities: [],
    };

    // Memories processing
    inventory.processingActivities.push({
      id: 'memories-processing',
      name: 'Memory Storage and Processing',
      purpose: 'AI memory storage, cognitive scoring, and cross-platform sync',
      categories: [
        'personal_data',
        'communication_content',
        'technical_data',
        'behavioral_data',
      ],
      subjects: ['user'],
      recipients: ['hivemind_team', 'qdrant_vector_db'],
      transfers: [],
      retention: 'Until user erasure request or 7 years after account deletion',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'LUKS2 encryption at rest',
        'TLS 1.3 in transit',
        'HYOK encryption pattern',
        'HSM-backed key management',
      ],
      dataCount: await prisma.memory.count({ where: { userId, deletedAt: null } }),
      lastUpdated: new Date().toISOString(),
    });

    // Platform integrations processing
    inventory.processingActivities.push({
      id: 'platform-integrations-processing',
      name: 'Platform Integration Management',
      purpose: 'OAuth2 authentication and cross-platform sync',
      categories: [
        'authentication_credentials',
        'access_tokens',
        'api_keys',
      ],
      subjects: ['user'],
      recipients: ['chatgpt', 'claude', 'perplexity', 'gemini'],
      transfers: [],
      retention: 'Until integration revoked or user erasure',
      legalBasis: 'Article 6(1)(b) - Contract necessity',
      securityMeasures: [
        'Encrypted token storage',
        'HSM-backed encryption',
        'Token rotation',
      ],
      dataCount: await prisma.platformIntegration.count({ where: { userId } }),
      lastUpdated: new Date().toISOString(),
    });

    // Sessions processing
    inventory.processingActivities.push({
      id: 'sessions-processing',
      name: 'Session Management',
      purpose: 'Cross-platform session tracking and context preservation',
      categories: [
        'session_metadata',
        'context_data',
        'usage_statistics',
      ],
      subjects: ['user'],
      recipients: ['hivemind_team'],
      transfers: [],
      retention: '90 days after session end',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'Encrypted session data',
        'Access logging',
      ],
      dataCount: await prisma.session.count({ where: { userId } }),
      lastUpdated: new Date().toISOString(),
    });

    // Sync processing
    inventory.processingActivities.push({
      id: 'sync-processing',
      name: 'Cross-Platform Sync',
      purpose: 'Synchronize memories across AI platforms',
      categories: [
        'memory_content',
        'sync_metadata',
        'payload_hashes',
      ],
      subjects: ['user'],
      recipients: ['qdrant_vector_db'],
      transfers: [],
      retention: '7 years for audit compliance',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'Encrypted sync payloads',
        'Audit logging',
        'Payload integrity verification',
      ],
      dataCount: await prisma.syncLog.count({ where: { userId } }),
      lastUpdated: new Date().toISOString(),
    });

    // Audit logging
    inventory.processingActivities.push({
      id: 'audit-logging',
      name: 'Audit Logging',
      purpose: 'Compliance with NIS2, DORA, and GDPR audit requirements',
      categories: [
        'access_logs',
        'data_modification_logs',
        'security_events',
      ],
      subjects: ['user', 'system'],
      recipients: ['dpo_team', 'security_team'],
      transfers: [],
      retention: '7 years (NIS2/DORA requirement)',
      legalBasis: 'Article 6(1)(c) - Legal obligation',
      securityMeasures: [
        'Immutable audit logs',
        'HSM-backed signing',
        'Tamper detection',
      ],
      dataCount: await prisma.auditLog.count({ where: { userId } }),
      lastUpdated: new Date().toISOString(),
    });

    // Export processing
    inventory.processingActivities.push({
      id: 'export-processing',
      name: 'Data Export',
      purpose: 'GDPR Article 20 - Right to data portability',
      categories: [
        'exported_data',
        'export_metadata',
      ],
      subjects: ['user'],
      recipients: ['user'],
      transfers: [],
      retention: '24 hours after export',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'Encrypted export files',
        'Signed URLs with expiry',
      ],
      dataCount: await prisma.dataExportRequest.count({ where: { userId, requestType: 'export' } }),
      lastUpdated: new Date().toISOString(),
    });

    // Erasure processing
    inventory.processingActivities.push({
      id: 'erasure-processing',
      name: 'Data Erasure',
      purpose: 'GDPR Article 17 - Right to erasure',
      categories: [
        'erasure_requests',
        'erasure_status',
      ],
      subjects: ['user'],
      recipients: ['dpo_team'],
      transfers: [],
      retention: '7 years for compliance',
      legalBasis: 'Article 6(1)(c) - Legal obligation',
      securityMeasures: [
        'Audit trail',
        'Grace period tracking',
      ],
      dataCount: await prisma.dataExportRequest.count({ where: { userId, requestType: 'erasure' } }),
      lastUpdated: new Date().toISOString(),
    });

    // Consent processing
    inventory.processingActivities.push({
      id: 'consent-processing',
      name: 'Consent Management',
      purpose: 'GDPR Article 7 - Conditions for consent',
      categories: [
        'consent_records',
        'consent_withdrawals',
      ],
      subjects: ['user'],
      recipients: ['dpo_team'],
      transfers: [],
      retention: '7 years for compliance',
      legalBasis: 'Article 6(1)(c) - Legal obligation',
      securityMeasures: [
        'Immutable consent records',
        'Timestamped entries',
      ],
      dataCount: await prisma.auditLog.count({
        where: {
          userId,
          eventType: { in: ['consent_granted', 'consent_withdrawn'] },
        },
      }),
      lastUpdated: new Date().toISOString(),
    });

    // Summary
    inventory.summary = {
      totalProcessingActivities: inventory.processingActivities.length,
      totalRecords: inventory.processingActivities.reduce((sum, a) => sum + (a.dataCount || 0), 0),
      lastUpdated: new Date().toISOString(),
    };

    logger.info('Data inventory generated', { userId, recordCount: inventory.summary.totalRecords });

    return inventory;
  } catch (error) {
    logger.error('Data inventory generation failed', { userId, error });
    throw error;
  }
}

/**
 * Get organization data inventory (for DPO audit)
 */
export async function getOrganizationDataInventory(orgId) {
  try {
    const inventory = {
      organizationId: orgId,
      generatedAt: new Date().toISOString(),
      processingActivities: [],
    };

    // Get all users in organization
    const users = await prisma.user.findMany({
      where: {
        organizations: { some: { orgId } },
        deletedAt: null,
      },
    });

    // Aggregate data across organization
    const aggregated = {
      memoryCount: await prisma.memory.count({
        where: {
          orgId,
          deletedAt: null,
        },
      }),
      sessionCount: await prisma.session.count({
        where: { user: { organizations: { some: { orgId } } } },
      }),
      platformIntegrationCount: await prisma.platformIntegration.count({
        where: { user: { organizations: { some: { orgId } } } },
      }),
      syncLogCount: await prisma.syncLog.count({
        where: { user: { organizations: { some: { orgId } } } },
      }),
      auditLogCount: await prisma.auditLog.count({
        where: { organizationId: orgId },
      }),
      userCount: users.length,
    };

    inventory.processingActivities.push({
      id: 'org-memories',
      name: 'Organization Memory Storage',
      purpose: 'Team knowledge base and collaboration',
      categories: ['personal_data', 'business_content'],
      subjects: ['organization_members'],
      recipients: ['organization_members'],
      retention: 'Until deletion or 7 years',
      legalBasis: 'Article 6(1)(b) - Contract necessity',
      securityMeasures: ['Access controls', 'Audit logging'],
      dataCount: aggregated.memoryCount,
    });

    inventory.processingActivities.push({
      id: 'org-platform-integrations',
      name: 'Organization Platform Integrations',
      purpose: 'Team AI platform access management',
      categories: ['authentication_credentials'],
      subjects: ['organization_members'],
      recipients: ['organization_admins', 'platforms'],
      retention: 'Until revoked',
      legalBasis: 'Article 6(1)(b) - Contract necessity',
      securityMeasures: ['Encrypted storage', 'HSM protection'],
      dataCount: aggregated.platformIntegrationCount,
    });

    inventory.summary = {
      organizationId: orgId,
      userCount: aggregated.userCount,
      totalRecords: aggregated.memoryCount + aggregated.sessionCount + aggregated.platformIntegrationCount,
      lastUpdated: new Date().toISOString(),
    };

    return inventory;
  } catch (error) {
    logger.error('Organization data inventory generation failed', { orgId, error });
    throw error;
  }
}

/**
 * Export data inventory for regulatory audit
 */
export async function exportDataInventory(format = 'json') {
  try {
    const inventory = {
      generatedAt: new Date().toISOString(),
      version: '1.0',
      processingActivities: [],
    };

    // Get all processing activities
    const activities = await prisma.$transaction([
      prisma.memory.groupBy({
        by: ['sourcePlatform'],
        _count: { sourcePlatform: true },
      }),
      prisma.platformIntegration.groupBy({
        by: ['platformType'],
        _count: { platformType: true },
      }),
      prisma.auditLog.groupBy({
        by: ['eventCategory'],
        _count: { eventCategory: true },
      }),
      prisma.user.count(),
    ]);

    const [platformCounts, integrationCounts, categoryCounts, userCount] = activities;

    inventory.processingActivities.push({
      id: 'memories',
      name: 'Memory Storage',
      purpose: 'AI memory storage and retrieval',
      categories: ['personal_data', 'communication_content'],
      subjects: ['users'],
      recipients: ['hivemind_team', 'qdrant'],
      retention: 'Until erasure or 7 years',
      legalBasis: 'Consent',
      dataCount: await prisma.memory.count({ where: { deletedAt: null } }),
      lastUpdated: new Date().toISOString(),
    });

    inventory.processingActivities.push({
      id: 'platform_integrations',
      name: 'Platform Integrations',
      purpose: 'Cross-platform authentication and sync',
      categories: ['authentication_credentials', 'access_tokens'],
      subjects: ['users'],
      recipients: ['platforms'],
      retention: 'Until revocation',
      legalBasis: 'Contract necessity',
      dataCount: await prisma.platformIntegration.count(),
      lastUpdated: new Date().toISOString(),
    });

    inventory.processingActivities.push({
      id: 'audit_logs',
      name: 'Audit Logging',
      purpose: 'Compliance and security monitoring',
      categories: ['access_logs', 'security_events'],
      subjects: ['users', 'system'],
      recipients: ['dpo_team', 'security_team'],
      retention: '7 years (NIS2/DORA)',
      legalBasis: 'Legal obligation',
      dataCount: await prisma.auditLog.count(),
      lastUpdated: new Date().toISOString(),
    });

    inventory.summary = {
      userCount,
      totalProcessingActivities: inventory.processingActivities.length,
      totalRecords: inventory.processingActivities.reduce((sum, a) => sum + (a.dataCount || 0), 0),
      lastUpdated: new Date().toISOString(),
    };

    // Add platform breakdown
    inventory.platformBreakdown = {
      memoriesByPlatform: platformCounts,
      integrationsByPlatform: integrationCounts,
      auditEventsByCategory: categoryCounts,
    };

    return inventory;
  } catch (error) {
    logger.error('Data inventory export failed', { error });
    throw error;
  }
}

/**
 * Get data subject rights status
 */
export async function getDataSubjectRightsStatus(userId) {
  try {
    const rightsStatus = {
      userId,
      generatedAt: new Date().toISOString(),
      rights: {
        access: {
          available: true,
          lastExercised: null,
        },
        rectification: {
          available: true,
          lastExercised: null,
        },
        erasure: {
          available: true,
          pending: false,
          lastRequested: null,
        },
        restriction: {
          available: true,
          lastExercised: null,
        },
        portability: {
          available: true,
          lastExercised: null,
        },
        objection: {
          available: true,
          lastExercised: null,
        },
      },
    };

    // Check for pending erasure
    const pendingErasure = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'erasure',
        status: { in: ['pending', 'processing', 'completed'] },
      },
      orderBy: { requestedAt: 'desc' },
    });

    if (pendingErasure && pendingErasure.status !== 'cancelled') {
      rightsStatus.rights.erasure.pending = true;
      rightsStatus.rights.erasure.lastRequested = pendingErasure.requestedAt;
    }

    // Check recent exports (portability)
    const recentExport = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'export',
        status: 'completed',
      },
      orderBy: { completedAt: 'desc' },
    });

    if (recentExport) {
      rightsStatus.rights.portability.lastExercised = recentExport.completedAt;
    }

    return rightsStatus;
  } catch (error) {
    logger.error('Data subject rights status check failed', { userId, error });
    throw error;
  }
}

/**
 * Get processing activities summary (for Article 30 documentation)
 */
export async function getProcessingActivitiesSummary() {
  try {
    const summary = {
      generatedAt: new Date().toISOString(),
      version: '1.0',
      processingActivities: [],
    };

    // Memories
    summary.processingActivities.push({
      id: 'memories',
      name: 'Memory Storage and Processing',
      purpose: 'Storage, categorization, and retrieval of user memories for AI assistance',
      categories: [
        'personal_data',
        'communication_content',
        'technical_data',
        'behavioral_data',
      ],
      dataSubjects: ['data_subjects'],
      recipients: ['hivemind_team', 'qdrant_vector_db'],
      internationalTransfers: [],
      retentionPeriod: 'Until user erasure request or 7 years after account deletion',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'LUKS2 encryption at rest',
        'TLS 1.3 in transit',
        'HYOK encryption pattern',
        'HSM-backed key management',
      ],
      dataProtectionOfficerContact: 'dpo@hivemind.io',
      dataTransferImpactAssessment: 'No international transfers',
    });

    // Platform Integrations
    summary.processingActivities.push({
      id: 'platform_integrations',
      name: 'Platform Integration Management',
      purpose: 'Authentication and data synchronization with AI platforms',
      categories: [
        'authentication_credentials',
        'access_tokens',
        'api_keys',
      ],
      dataSubjects: ['data_subjects'],
      recipients: ['chatgpt', 'claude', 'perplexity', 'gemini'],
      internationalTransfers: [],
      retentionPeriod: 'Until integration revoked or user erasure',
      legalBasis: 'Article 6(1)(b) - Contract necessity',
      securityMeasures: [
        'Encrypted token storage',
        'HSM-backed encryption',
        'Token rotation',
      ],
      dataProtectionOfficerContact: 'dpo@hivemind.io',
      dataTransferImpactAssessment: 'No international transfers',
    });

    // Audit Logging
    summary.processingActivities.push({
      id: 'audit_logging',
      name: 'Audit Logging',
      purpose: 'Compliance with NIS2, DORA, and GDPR audit requirements',
      categories: [
        'access_logs',
        'data_modification_logs',
        'security_events',
      ],
      dataSubjects: ['data_subjects', 'system'],
      recipients: ['dpo_team', 'security_team'],
      internationalTransfers: [],
      retentionPeriod: '7 years (NIS2/DORA requirement)',
      legalBasis: 'Article 6(1)(c) - Legal obligation',
      securityMeasures: [
        'Immutable audit logs',
        'HSM-backed signing',
        'Tamper detection',
      ],
      dataProtectionOfficerContact: 'dpo@hivemind.io',
      dataTransferImpactAssessment: 'No international transfers',
    });

    // Export Processing
    summary.processingActivities.push({
      id: 'export_processing',
      name: 'Data Export',
      purpose: 'GDPR Article 20 - Right to data portability',
      categories: [
        'exported_data',
        'export_metadata',
      ],
      dataSubjects: ['data_subjects'],
      recipients: ['data_subjects'],
      internationalTransfers: [],
      retentionPeriod: '24 hours after export',
      legalBasis: 'Article 6(1)(a) - Consent',
      securityMeasures: [
        'Encrypted export files',
        'Signed URLs with expiry',
      ],
      dataProtectionOfficerContact: 'dpo@hivemind.io',
      dataTransferImpactAssessment: 'No international transfers',
    });

    // Erasure Processing
    summary.processingActivities.push({
      id: 'erasure_processing',
      name: 'Data Erasure',
      purpose: 'GDPR Article 17 - Right to erasure',
      categories: [
        'erasure_requests',
        'erasure_status',
      ],
      dataSubjects: ['data_subjects'],
      recipients: ['dpo_team'],
      internationalTransfers: [],
      retentionPeriod: '7 years for compliance',
      legalBasis: 'Article 6(1)(c) - Legal obligation',
      securityMeasures: [
        'Audit trail',
        'Grace period tracking',
      ],
      dataProtectionOfficerContact: 'dpo@hivemind.io',
      dataTransferImpactAssessment: 'No international transfers',
    });

    return summary;
  } catch (error) {
    logger.error('Processing activities summary generation failed', { error });
    throw error;
  }
}

export default {
  getUserDataInventory,
  getOrganizationDataInventory,
  exportDataInventory,
  getDataSubjectRightsStatus,
  getProcessingActivitiesSummary,
  ARTICLE_30_FIELDS,
};
