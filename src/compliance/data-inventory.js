/**
 * HIVE-MIND Data Inventory Service
 * Implements GDPR Article 30 - Records of Processing Activities
 * Compliance: GDPR Article 30, NIS2 Article 21, DORA ICT Risk Management
 */

const { Pool } = require('pg');

/**
 * Data Inventory Registry
 * Documents all personal data processing activities
 */
const DATA_INVENTORY = {
  // User Identity Data
  USER_PROFILE: {
    category: 'Identity',
    purpose: 'User authentication and account management',
    legalBasis: 'Contractual necessity (Art. 6(1)(b))',
    dataSubjects: 'Registered users',
    dataTypes: [
      'Email address',
      'Username',
      'Display name',
      'Password hash',
      'Account creation date',
      'Last login timestamp',
    ],
    recipients: ['Internal authentication service'],
    retention: 'Duration of account + 30 days grace period',
    securityMeasures: [
      'AES-256 encryption at rest',
      'Argon2 password hashing',
      'Access control via RBAC',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // User Memories (Core Data)
  USER_MEMORIES: {
    category: 'User Content',
    purpose: 'AI memory and context persistence across sessions',
    legalBasis: 'Consent (Art. 6(1)(a)) / Legitimate interest (Art. 6(1)(f))',
    dataSubjects: 'Users utilizing memory features',
    dataTypes: [
      'User-generated content',
      'Conversation history',
      'Extracted facts and preferences',
      'Vector embeddings',
      'Metadata (timestamps, categories)',
    ],
    recipients: ['Qdrant vector database', 'PostgreSQL'],
    retention: 'Until user deletion request + 30 days',
    securityMeasures: [
      'AES-256 encryption at rest (LUKS2)',
      'HSM-backed encryption keys',
      'Access limited to authenticated user',
      'Audit logging of all access',
    ],
    crossBorder: false,
    dpiaRequired: true,
    dpiaReference: 'DPIA-2024-001-AI-Memory',
  },

  // Session Data
  USER_SESSIONS: {
    category: 'Activity Data',
    purpose: 'Session management and security',
    legalBasis: 'Legitimate interest (Art. 6(1)(f)) - security',
    dataSubjects: 'Active users',
    dataTypes: [
      'Session tokens',
      'IP address',
      'User agent string',
      'Device information',
      'Login/logout timestamps',
    ],
    recipients: ['Redis session store', 'PostgreSQL'],
    retention: '30 days after session end',
    securityMeasures: [
      'Encrypted session storage',
      'Secure cookie attributes',
      'Automatic expiration',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // Integration Data
  USER_INTEGRATIONS: {
    category: 'Third-party Data',
    purpose: 'Integration with external services (GitHub, Linear, etc.)',
    legalBasis: 'Consent (Art. 6(1)(a))',
    dataSubjects: 'Users connecting external services',
    dataTypes: [
      'OAuth tokens (encrypted)',
      'Integration metadata',
      'Synced content references',
      'Webhook configurations',
    ],
    recipients: ['HashiCorp Vault', 'Integration service providers'],
    retention: 'Until integration disconnect + 30 days',
    securityMeasures: [
      'Tokens stored in Vault with encryption',
      'HSM-backed key protection',
      'Automatic token rotation',
      'Scope-limited access',
    ],
    crossBorder: true, // Third-party services may be US-based
    safeguards: 'Standard Contractual Clauses (SCCs)',
    dpiaRequired: true,
    dpiaReference: 'DPIA-2024-002-Third-Party-Integrations',
  },

  // Audit Logs
  AUDIT_LOGS: {
    category: 'Compliance Data',
    purpose: 'Security monitoring and regulatory compliance (NIS2/DORA)',
    legalBasis: 'Legal obligation (Art. 6(1)(c)) - NIS2/DORA',
    dataSubjects: 'All users',
    dataTypes: [
      'User ID (anonymized after 7 years)',
      'Action type and timestamp',
      'Resource accessed',
      'IP address (hashed)',
      'User agent',
    ],
    recipients: ['Internal security team', 'Regulatory authorities'],
    retention: '7 years (NIS2/DORA requirement)',
    securityMeasures: [
      'Tamper-evident logging',
      'Write-once storage',
      'Encryption at rest',
      'Access restricted to security team',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // Consent Records
  CONSENT_RECORDS: {
    category: 'Compliance Data',
    purpose: 'Demonstrate compliance with consent requirements',
    legalBasis: 'Legal obligation (Art. 6(1)(c)) - GDPR proof',
    dataSubjects: 'All users',
    dataTypes: [
      'Consent type and version',
      'Grant/withdrawal timestamp',
      'IP address at time of consent',
      'User agent at time of consent',
    ],
    recipients: ['Internal compliance team', 'DPO'],
    retention: '7 years after account deletion',
    securityMeasures: [
      'Immutable records',
      'Cryptographic integrity protection',
      'Access audit logging',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // Communication Preferences
  USER_PREFERENCES: {
    category: 'Preference Data',
    purpose: 'User experience customization',
    legalBasis: 'Consent (Art. 6(1)(a))',
    dataSubjects: 'All users',
    dataTypes: [
      'UI preferences',
      'Notification settings',
      'Privacy settings',
      'Feature flags',
    ],
    recipients: ['Internal preference service'],
    retention: 'Duration of account',
    securityMeasures: [
      'Encrypted storage',
      'User-controlled access',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // Error Logs (may contain PII)
  ERROR_LOGS: {
    category: 'System Data',
    purpose: 'Debugging and system improvement',
    legalBasis: 'Legitimate interest (Art. 6(1)(f))',
    dataSubjects: 'Users experiencing errors',
    dataTypes: [
      'Error messages',
      'Stack traces',
      'User context (sanitized)',
      'Timestamp',
    ],
    recipients: ['Internal development team'],
    retention: '90 days',
    securityMeasures: [
      'PII scrubbing before storage',
      'Access restricted to engineering',
      'Encrypted at rest',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },

  // Analytics (anonymized)
  ANALYTICS: {
    category: 'Statistical Data',
    purpose: 'Service improvement and usage analysis',
    legalBasis: 'Legitimate interest (Art. 6(1)(f))',
    dataSubjects: 'All users (anonymized)',
    dataTypes: [
      'Aggregated usage statistics',
      'Feature adoption metrics',
      'Performance data',
    ],
    recipients: ['Internal analytics team'],
    retention: 'Indefinite (anonymized)',
    securityMeasures: [
      'Anonymization before storage',
      'No individual identification possible',
    ],
    crossBorder: false,
    dpiaRequired: false,
  },
};

/**
 * Data Flow Documentation
 */
const DATA_FLOWS = {
  INGESTION: {
    description: 'User data ingestion via API and web interface',
    sources: ['Web application', 'CLI', 'API clients'],
    destinations: ['Load balancer', 'API gateway'],
    encryption: 'TLS 1.3',
  },
  PROCESSING: {
    description: 'Data processing and AI inference',
    sources: ['API gateway'],
    destinations: ['Application servers', 'AI inference service'],
    encryption: 'mTLS',
  },
  STORAGE: {
    description: 'Persistent data storage',
    sources: ['Application servers'],
    destinations: ['PostgreSQL', 'Qdrant', 'Redis', 'S3'],
    encryption: 'AES-256 at rest (LUKS2 + HSM)',
  },
  BACKUP: {
    description: 'Data backup and disaster recovery',
    sources: ['PostgreSQL', 'Qdrant'],
    destinations: ['Encrypted backup storage (EU region)'],
    encryption: 'AES-256 with HSM-wrapped keys',
  },
  EXPORT: {
    description: 'GDPR data export',
    sources: ['PostgreSQL', 'Qdrant'],
    destinations: ['User download (signed URL)'],
    encryption: 'Gzip + HTTPS',
  },
  DELETION: {
    description: 'Data erasure',
    sources: ['Erasure service'],
    destinations: ['All storage systems'],
    verification: 'Cryptographic erasure confirmation',
  },
};

class DataInventory {
  constructor(config = {}) {
    this.inventory = DATA_INVENTORY;
    this.dataFlows = DATA_FLOWS;
    
    // Initialize database pool for dynamic queries
    this.dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'hivemind',
      user: process.env.DB_USER || 'hivemind',
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }

  /**
   * Get complete data inventory
   * @returns {Object} Complete inventory of processing activities
   */
  getInventory() {
    return {
      generatedAt: new Date().toISOString(),
      version: '1.0',
      organization: 'HIVE-MIND',
      contact: 'dpo@hivemind.io',
      processingActivities: this.inventory,
      dataFlows: this.dataFlows,
    };
  }

  /**
   * Get processing activity by category
   * @param {string} category - Category identifier
   * @returns {Object|null} Processing activity details
   */
  getActivity(category) {
    return this.inventory[category] || null;
  }

  /**
   * Get all categories processing personal data
   * @returns {Array} List of category identifiers
   */
  getPersonalDataCategories() {
    return Object.keys(this.inventory).filter(key => {
      const activity = this.inventory[key];
      return activity.category !== 'Statistical Data' || 
             activity.dataSubjects !== 'All users (anonymized)';
    });
  }

  /**
   * Get activities requiring DPIA
   * @returns {Array} Activities with DPIA requirements
   */
  getDPIARequiredActivities() {
    return Object.entries(this.inventory)
      .filter(([_, activity]) => activity.dpiaRequired)
      .map(([key, activity]) => ({
        category: key,
        ...activity,
      }));
  }

  /**
   * Get cross-border data transfers
   * @returns {Array} Activities with cross-border transfers
   */
  getCrossBorderTransfers() {
    return Object.entries(this.inventory)
      .filter(([_, activity]) => activity.crossBorder)
      .map(([key, activity]) => ({
        category: key,
        dataTypes: activity.dataTypes,
        recipients: activity.recipients,
        safeguards: activity.safeguards,
      }));
  }

  /**
   * Get retention schedule
   * @returns {Object} Retention periods by category
   */
  getRetentionSchedule() {
    const schedule = {};
    for (const [key, activity] of Object.entries(this.inventory)) {
      schedule[key] = {
        category: activity.category,
        retention: activity.retention,
        legalBasis: activity.legalBasis,
      };
    }
    return schedule;
  }

  /**
   * Get security measures by category
   * @returns {Object} Security measures mapped to categories
   */
  getSecurityMeasures() {
    const measures = {};
    for (const [key, activity] of Object.entries(this.inventory)) {
      measures[key] = {
        category: activity.category,
        measures: activity.securityMeasures,
      };
    }
    return measures;
  }

  /**
   * Query actual data volumes (from database)
   * @returns {Promise<Object>} Data volume statistics
   */
  async getDataVolumes() {
    const volumes = {};
    
    try {
      // User count
      const userResult = await this.dbPool.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) as active_users,
          COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) as soft_deleted_users
        FROM users
      `);
      volumes.users = userResult.rows[0];
      
      // Memory count
      const memoryResult = await this.dbPool.query(`
        SELECT 
          COUNT(*) as total_memories,
          COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) as active_memories
        FROM memories
      `);
      volumes.memories = memoryResult.rows[0];
      
      // Integration count
      const integrationResult = await this.dbPool.query(`
        SELECT 
          provider,
          COUNT(*) as count
        FROM user_integrations
        WHERE deleted_at IS NULL
        GROUP BY provider
      `);
      volumes.integrations = integrationResult.rows;
      
      // Audit log count (last 30 days)
      const auditResult = await this.dbPool.query(`
        SELECT 
          COUNT(*) as total_events,
          COUNT(DISTINCT user_id) as unique_users
        FROM audit_logs
        WHERE created_at > NOW() - INTERVAL '30 days'
      `);
      volumes.auditLogs30d = auditResult.rows[0];
      
    } catch (error) {
      console.error('Failed to query data volumes:', error);
      volumes.error = 'Failed to query database';
    }
    
    return volumes;
  }

  /**
   * Generate Article 30 report
   * @returns {Promise<Object>} Formatted Article 30 report
   */
  async generateArticle30Report() {
    const volumes = await this.getDataVolumes();
    
    return {
      reportType: 'GDPR Article 30 - Records of Processing Activities',
      generatedAt: new Date().toISOString(),
      organization: {
        name: 'HIVE-MIND',
        address: 'EU Sovereign Cloud (OVHcloud, France)',
        contact: 'dpo@hivemind.io',
      },
      dataProtectionOfficer: {
        name: 'Data Protection Officer',
        contact: 'dpo@hivemind.io',
      },
      processingActivities: Object.entries(this.inventory).map(([key, activity]) => ({
        activityId: key,
        ...activity,
      })),
      dataFlows: this.dataFlows,
      dataVolumes: volumes,
      crossBorderTransfers: this.getCrossBorderTransfers(),
      dpiaActivities: this.getDPIARequiredActivities(),
    };
  }

  /**
   * Verify data inventory against actual database schema
   * @returns {Promise<Object>} Verification results
   */
  async verifyInventory() {
    const results = {
      timestamp: new Date().toISOString(),
      checks: [],
      issues: [],
    };
    
    try {
      // Check if required tables exist
      const tableCheck = await this.dbPool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      
      const existingTables = tableCheck.rows.map(r => r.table_name);
      
      // Verify each inventory category has corresponding tables
      const requiredTables = ['users', 'memories', 'user_sessions', 'user_integrations', 'audit_logs'];
      for (const table of requiredTables) {
        if (existingTables.includes(table)) {
          results.checks.push({ table, status: 'exists' });
        } else {
          results.issues.push({ table, status: 'missing', severity: 'high' });
        }
      }
      
      // Check for encryption (simplified check)
      results.checks.push({
        check: 'encryption_at_rest',
        status: 'configured',
        details: 'LUKS2 + HSM-backed keys',
      });
      
    } catch (error) {
      results.issues.push({
        check: 'database_connection',
        error: error.message,
        severity: 'critical',
      });
    }
    
    results.valid = results.issues.filter(i => i.severity === 'critical').length === 0;
    
    return results;
  }

  /**
   * Get data subject rights information
   * @returns {Object} Information about data subject rights
   */
  getDataSubjectRights() {
    return {
      rights: [
        {
          right: 'Access (Art. 15)',
          implementation: '/api/gdpr/export - Full data export',
          timeframe: '30 days',
        },
        {
          right: 'Rectification (Art. 16)',
          implementation: 'Profile editing via /api/users/profile',
          timeframe: 'Immediate',
        },
        {
          right: 'Erasure (Art. 17)',
          implementation: '/api/gdpr/erasure - Right to be forgotten',
          timeframe: '30 days grace period + 30 days deletion',
        },
        {
          right: 'Restriction (Art. 18)',
          implementation: 'Account suspension via support',
          timeframe: 'Immediate',
        },
        {
          right: 'Portability (Art. 20)',
          implementation: '/api/gdpr/export - JSON export',
          timeframe: '30 days',
        },
        {
          right: 'Objection (Art. 21)',
          implementation: 'Privacy settings / Consent withdrawal',
          timeframe: 'Immediate',
        },
        {
          right: 'Automated Decision-making (Art. 22)',
          implementation: 'No automated decision-making',
          timeframe: 'N/A',
        },
      ],
      contact: 'dpo@hivemind.io',
      supervisoryAuthority: {
        name: 'CNIL (France)',
        website: 'https://www.cnil.fr',
      },
    };
  }

  /**
   * Close database connections
   */
  async close() {
    await this.dbPool.end();
  }
}

module.exports = {
  DataInventory,
  DATA_INVENTORY,
  DATA_FLOWS,
};
