/**
 * HIVE-MIND Audit Middleware
 * Express middleware for automatic audit logging
 * Captures all API requests and responses
 */

const { AuditLogger, EVENT_CATEGORIES, EVENT_TYPES } = require('./logger');

class AuditMiddleware {
  constructor(options = {}) {
    this.logger = new AuditLogger(options);
    this.excludedPaths = options.excludedPaths || [
      '/health',
      '/metrics',
      '/favicon.ico',
      '/static',
    ];
    this.sensitivePaths = options.sensitivePaths || [
      '/api/auth/login',
      '/api/auth/refresh',
    ];
  }

  /**
   * Main middleware function
   */
  middleware() {
    return async (req, res, next) => {
      // Skip excluded paths
      if (this.isExcluded(req.path)) {
        return next();
      }

      const startTime = Date.now();
      
      // Capture original end function
      const originalEnd = res.end;
      
      // Override end to capture response
      res.end = async (chunk, encoding) => {
        // Restore original end
        res.end = originalEnd;
        res.end(chunk, encoding);
        
        // Calculate duration
        const duration = Date.now() - startTime;
        
        // Log the request
        await this.logRequest(req, res, duration);
      };
      
      next();
    };
  }

  /**
   * Check if path should be excluded
   */
  isExcluded(path) {
    return this.excludedPaths.some(excluded => 
      path.startsWith(excluded) || path === excluded
    );
  }

  /**
   * Log the request/response
   */
  async logRequest(req, res, duration) {
    try {
      const eventType = this.determineEventType(req, res);
      const eventCategory = this.determineEventCategory(req);
      
      await this.logger.log({
        eventType,
        eventCategory,
        userId: req.user?.id || null,
        userType: req.user?.type || 'ANONYMOUS',
        sessionId: req.session?.id || null,
        resourceType: this.determineResourceType(req),
        resourceId: req.params?.id || null,
        action: req.method,
        actionResult: this.determineActionResult(res),
        ipAddress: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
        requestId: req.id || req.headers['x-request-id'],
        metadata: {
          path: req.path,
          route: req.route?.path,
          query: this.sanitizeQuery(req.query),
          statusCode: res.statusCode,
          duration,
          contentLength: res.get('content-length'),
          contentType: res.get('content-type'),
          // Don't log request body for sensitive paths
          body: this.sensitivePaths.includes(req.path) ? '[REDACTED]' : undefined,
        },
      });
    } catch (error) {
      // Never fail the request due to audit logging
      console.error('Audit middleware error:', error);
    }
  }

  /**
   * Determine event type from request
   */
  determineEventType(req, res) {
    const method = req.method;
    const path = req.path;
    
    // Authentication events
    if (path.includes('/auth/login')) {
      return res.statusCode === 200 
        ? EVENT_TYPES.LOGIN_SUCCESS 
        : EVENT_TYPES.LOGIN_FAILURE;
    }
    
    if (path.includes('/auth/logout')) {
      return EVENT_TYPES.LOGOUT;
    }
    
    if (path.includes('/auth/password')) {
      return EVENT_TYPES.PASSWORD_CHANGED;
    }
    
    // Data operations
    if (method === 'GET') {
      if (path.includes('/export')) {
        return EVENT_TYPES.DATA_EXPORT_REQUESTED;
      }
      return EVENT_TYPES.DATA_READ;
    }
    
    if (method === 'POST') {
      if (path.includes('/erasure')) {
        return EVENT_TYPES.GDPR_ERASURE_REQUESTED;
      }
      return EVENT_TYPES.DATA_CREATED;
    }
    
    if (method === 'PUT' || method === 'PATCH') {
      return EVENT_TYPES.DATA_UPDATED;
    }
    
    if (method === 'DELETE') {
      return EVENT_TYPES.DATA_DELETED;
    }
    
    return EVENT_TYPES.DATA_READ;
  }

  /**
   * Determine event category
   */
  determineEventCategory(req) {
    const path = req.path;
    
    if (path.includes('/auth')) {
      return EVENT_CATEGORIES.AUTHENTICATION;
    }
    
    if (path.includes('/admin')) {
      return EVENT_CATEGORIES.ADMINISTRATIVE;
    }
    
    if (path.includes('/gdpr')) {
      return EVENT_CATEGORIES.COMPLIANCE;
    }
    
    if (path.includes('/consent')) {
      return EVENT_CATEGORIES.CONSENT;
    }
    
    return EVENT_CATEGORIES.DATA_ACCESS;
  }

  /**
   * Determine resource type from path
   */
  determineResourceType(req) {
    const path = req.path;
    
    if (path.includes('/memories')) return 'MEMORY';
    if (path.includes('/users')) return 'USER';
    if (path.includes('/sessions')) return 'SESSION';
    if (path.includes('/integrations')) return 'INTEGRATION';
    if (path.includes('/preferences')) return 'PREFERENCE';
    if (path.includes('/export')) return 'EXPORT';
    if (path.includes('/erasure')) return 'ERASURE_REQUEST';
    
    return 'API_ENDPOINT';
  }

  /**
   * Determine action result from response
   */
  determineActionResult(res) {
    const status = res.statusCode;
    
    if (status >= 200 && status < 300) return 'SUCCESS';
    if (status === 403) return 'DENIED';
    if (status === 401) return 'DENIED';
    if (status >= 400) return 'FAILURE';
    
    return 'SUCCESS';
  }

  /**
   * Sanitize query parameters
   */
  sanitizeQuery(query) {
    const sanitized = { ...query };
    
    // Remove sensitive fields
    delete sanitized.token;
    delete sanitized.api_key;
    delete sanitized.password;
    delete sanitized.secret;
    
    return sanitized;
  }

  /**
   * Security event logging helper
   */
  async logSecurityEvent(eventType, details) {
    await this.logger.log({
      eventType,
      eventCategory: EVENT_CATEGORIES.SECURITY,
      ...details,
    });
  }

  /**
   * Authentication event logging helper
   */
  async logAuthEvent(eventType, userId, details = {}) {
    await this.logger.log({
      eventType,
      eventCategory: EVENT_CATEGORIES.AUTHENTICATION,
      userId,
      ...details,
    });
  }
}

module.exports = {
  AuditMiddleware,
};
