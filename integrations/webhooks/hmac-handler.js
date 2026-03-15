/**
 * Universal Webhook HMAC Handler
 * 
 * Provides HMAC-SHA256 signature verification and generation for webhooks
 * from all supported platforms (ChatGPT, Claude, Perplexity, Gemini, etc.)
 * 
 * @module webhooks/hmac-handler
 */

import crypto from 'crypto';
import { z } from 'zod';

// Logger
const logger = {
  info: (msg, ctx) => console.log(`[WEBHOOK INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[WEBHOOK WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[WEBHOOK ERROR] ${msg}`, ctx)
};

// ==========================================
// Configuration
// ==========================================

const WEBHOOK_CONFIG = {
  // Timestamp freshness window (5 minutes)
  maxTimestampAgeMs: 5 * 60 * 1000,
  
  // Platform-specific secrets (loaded from environment)
  secrets: {
    chatgpt: process.env.CHATGPT_WEBHOOK_SECRET,
    claude: process.env.CLAUDE_WEBHOOK_SECRET,
    perplexity: process.env.PERPLEXITY_WEBHOOK_SECRET,
    gemini: process.env.GEMINI_WEBHOOK_SECRET,
    generic: process.env.WEBHOOK_SECRET
  },

  // Platform-specific header names
  headers: {
    chatgpt: { signature: 'x-chatgpt-signature', timestamp: 'x-chatgpt-timestamp' },
    claude: { signature: 'x-claude-signature', timestamp: 'x-claude-timestamp' },
    perplexity: { signature: 'x-perplexity-signature', timestamp: 'x-perplexity-timestamp' },
    gemini: { signature: 'x-gemini-signature', timestamp: 'x-gemini-timestamp' },
    generic: { signature: 'x-webhook-signature', timestamp: 'x-webhook-timestamp' }
  }
};

// ==========================================
// Zod Schemas
// ==========================================

const WebhookSignatureSchema = z.object({
  signature: z.string().hex(),
  timestamp: z.string().regex(/^\d+$/),
  payload: z.unknown()
});

const WebhookHeadersSchema = z.object({
  signature: z.string().optional(),
  timestamp: z.string().optional()
});

// ==========================================
// HMAC Signature Functions
// ==========================================

/**
 * Generate HMAC-SHA256 signature for webhook payload
 * 
 * @param {object} payload - Webhook payload to sign
 * @param {string} secret - Secret key for signing
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Hex-encoded signature
 */
export function generateSignature(payload, secret, timestamp = null) {
  if (!secret) {
    throw new Error('Webhook secret not configured');
  }

  const ts = timestamp || Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const signedPayload = `${ts}.${body}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return signature;
}

/**
 * Verify HMAC-SHA256 webhook signature
 * Uses timing-safe comparison to prevent timing attacks
 * 
 * @param {string} body - Raw request body string
 * @param {string} signature - Signature from header
 * @param {string} secret - Secret key for verification
 * @param {string} timestamp - Timestamp from header
 * @returns {boolean} True if signature is valid
 * @throws {Error} If verification fails
 */
export function verifySignature(body, signature, secret, timestamp) {
  if (!secret) {
    logger.error('Webhook secret not configured');
    throw new Error('Server configuration error');
  }

  if (!signature || !timestamp) {
    logger.warn('Missing signature or timestamp');
    return false;
  }

  // Validate timestamp format
  const timestampNum = parseInt(timestamp, 10);
  if (isNaN(timestampNum)) {
    logger.warn('Invalid timestamp format');
    return false;
  }

  // Check timestamp freshness
  const now = Date.now();
  const webhookTime = timestampNum * 1000;
  const age = Math.abs(now - webhookTime);

  if (age > WEBHOOK_CONFIG.maxTimestampAgeMs) {
    logger.warn('Webhook timestamp expired', {
      timestamp,
      now,
      age,
      maxAge: WEBHOOK_CONFIG.maxTimestampAgeMs
    });
    return false;
  }

  // Create expected signature
  const signedPayload = `${timestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Timing-safe comparison
  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length) {
      logger.warn('Signature length mismatch');
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (error) {
    logger.error('Signature comparison failed', { error: error.message });
    return false;
  }
}

/**
 * Verify webhook signature from Express request
 * 
 * @param {object} req - Express request object
 * @param {string} platform - Platform name (chatgpt, claude, etc.)
 * @returns {object} Verification result
 */
export function verifyRequestSignature(req, platform = 'generic') {
  const config = WEBHOOK_CONFIG.headers[platform] || WEBHOOK_CONFIG.headers.generic;
  const secret = WEBHOOK_CONFIG.secrets[platform] || WEBHOOK_CONFIG.secrets.generic;

  const signature = req.headers[config.signature];
  const timestamp = req.headers[config.timestamp];
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  const isValid = verifySignature(body, signature, secret, timestamp);

  return {
    isValid,
    signature,
    timestamp,
    platform,
    body
  };
}

// ==========================================
// Express Middleware
// ==========================================

/**
 * Express middleware to verify webhook signatures
 * 
 * @param {string} platform - Platform name (optional, defaults to 'generic')
 * @returns {function} Express middleware
 */
export function webhookSignatureMiddleware(platform = 'generic') {
  return (req, res, next) => {
    const config = WEBHOOK_CONFIG.headers[platform] || WEBHOOK_CONFIG.headers.generic;
    const secret = WEBHOOK_CONFIG.secrets[platform] || WEBHOOK_CONFIG.secrets.generic;

    // Check if secret is configured
    if (!secret) {
      logger.error('Webhook secret not configured', { platform });
      res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Webhook secret not configured for this platform',
        platform
      });
      return;
    }

    // Get signature and timestamp from headers
    const signature = req.headers[config.signature];
    const timestamp = req.headers[config.timestamp];

    // Check for required headers
    if (!signature || !timestamp) {
      logger.warn('Missing webhook signature headers', {
        platform,
        hasSignature: !!signature,
        hasTimestamp: !!timestamp
      });
      res.status(401).json({
        error: 'MISSING_SIGNATURE',
        message: 'Missing required signature headers',
        required: [config.signature, config.timestamp]
      });
      return;
    }

    // Get raw body for signature verification
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Verify signature
    const isValid = verifySignature(body, signature, secret, timestamp);

    if (!isValid) {
      logger.warn('Invalid webhook signature', {
        platform,
        signature: signature?.substring(0, 16) + '...',
        timestamp
      });
      res.status(401).json({
        error: 'INVALID_SIGNATURE',
        message: 'Invalid webhook signature'
      });
      return;
    }

    // Signature valid, continue
    req.webhookVerified = true;
    req.webhookPlatform = platform;
    req.webhookTimestamp = new Date(parseInt(timestamp, 10) * 1000);

    next();
  };
}

/**
 * Multi-platform webhook middleware
 * Automatically detects platform from URL or header
 * 
 * @returns {function} Express middleware
 */
export function multiPlatformWebhookMiddleware() {
  return (req, res, next) => {
    // Try to detect platform from URL path
    const urlPath = req.path.toLowerCase();
    let platform = 'generic';

    if (urlPath.includes('chatgpt') || urlPath.includes('chat-gpt')) {
      platform = 'chatgpt';
    } else if (urlPath.includes('claude')) {
      platform = 'claude';
    } else if (urlPath.includes('perplexity')) {
      platform = 'perplexity';
    } else if (urlPath.includes('gemini')) {
      platform = 'gemini';
    }

    // Check for explicit platform header
    const platformHeader = req.headers['x-webhook-platform'];
    if (platformHeader && WEBHOOK_CONFIG.secrets[platformHeader]) {
      platform = platformHeader;
    }

    // Use platform-specific middleware
    webhookSignatureMiddleware(platform)(req, res, next);
  };
}

// ==========================================
// Outgoing Webhook Functions
// ==========================================

/**
 * Prepare outgoing webhook with signature
 * 
 * @param {object} payload - Webhook payload
 * @param {string} platform - Target platform
 * @returns {object} Headers and signed payload
 */
export function prepareOutgoingWebhook(payload, platform = 'generic') {
  const secret = WEBHOOK_CONFIG.secrets[platform] || WEBHOOK_CONFIG.secrets.generic;
  const config = WEBHOOK_CONFIG.headers[platform] || WEBHOOK_CONFIG.headers.generic;

  if (!secret) {
    throw new Error(`Webhook secret not configured for platform: ${platform}`);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = generateSignature(payload, secret, timestamp);

  return {
    headers: {
      'Content-Type': 'application/json',
      [config.signature]: signature,
      [config.timestamp]: timestamp.toString(),
      'User-Agent': 'HIVE-MIND-Webhook/1.0'
    },
    payload,
    timestamp: new Date(timestamp * 1000),
    signature
  };
}

/**
 * Send webhook to external endpoint
 * 
 * @param {string} url - Webhook URL
 * @param {object} payload - Webhook payload
 * @param {string} platform - Target platform
 * @param {object} options - Fetch options
 * @returns {Promise<object>} Response data
 */
export async function sendWebhook(url, payload, platform = 'generic', options = {}) {
  const { timeout = 5000, retries = 3 } = options;
  
  const { headers, payload: signedPayload } = prepareOutgoingWebhook(payload, platform);

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(signedPayload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json().catch(() => null);

      logger.info('Webhook sent successfully', {
        url,
        platform,
        status: response.status,
        attempt
      });

      return {
        success: true,
        status: response.status,
        data,
        attempt
      };

    } catch (error) {
      lastError = error;
      logger.warn('Webhook send failed', {
        url,
        platform,
        attempt,
        error: error.message
      });

      if (attempt < retries) {
        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('Webhook send failed after all retries', {
    url,
    platform,
    retries,
    error: lastError?.message
  });

  return {
    success: false,
    error: lastError?.message,
    retries
  };
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Get configured platforms
 * 
 * @returns {string[]} Array of configured platform names
 */
export function getConfiguredPlatforms() {
  return Object.entries(WEBHOOK_CONFIG.secrets)
    .filter(([_, secret]) => !!secret)
    .map(([platform]) => platform);
}

/**
 * Check if platform is configured
 * 
 * @param {string} platform - Platform name
 * @returns {boolean} True if configured
 */
export function isPlatformConfigured(platform) {
  return !!WEBHOOK_CONFIG.secrets[platform];
}

/**
 * Get header names for platform
 * 
 * @param {string} platform - Platform name
 * @returns {object} Header configuration
 */
export function getPlatformHeaders(platform) {
  return WEBHOOK_CONFIG.headers[platform] || WEBHOOK_CONFIG.headers.generic;
}

// ==========================================
// Exports
// ==========================================

export default {
  generateSignature,
  verifySignature,
  verifyRequestSignature,
  webhookSignatureMiddleware,
  multiPlatformWebhookMiddleware,
  prepareOutgoingWebhook,
  sendWebhook,
  getConfiguredPlatforms,
  isPlatformConfigured,
  getPlatformHeaders,
  WEBHOOK_CONFIG
};
