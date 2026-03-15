/**
 * HIVE-MIND Base Skill Class
 * All skills should extend this class for consistent lifecycle and API
 */

import { EventEmitter } from 'events';

export class BaseSkill extends EventEmitter {
  constructor(options = {}) {
    super();
    this.skillId = options.skillId;
    this.manifest = options.manifest;
    this.registry = options.registry;
    this.config = options.config || {};
    this.initialized = false;
    this.status = 'created';
  }

  /**
   * Initialize the skill
   * Override this in your skill
   */
  async initialize() {
    this.initialized = true;
    this.status = 'active';
    this.emit('initialized');
  }

  /**
   * Destroy/cleanup the skill
   * Override this in your skill for cleanup
   */
  async destroy() {
    this.initialized = false;
    this.status = 'destroyed';
    this.emit('destroyed');
  }

  /**
   * Get skill info
   */
  getInfo() {
    return {
      id: this.skillId,
      name: this.manifest.name,
      version: this.manifest.version,
      description: this.manifest.description,
      author: this.manifest.author,
      status: this.status,
      initialized: this.initialized
    };
  }

  /**
   * Get configuration value
   */
  getConfig(key, defaultValue = null) {
    return this.config[key] ?? defaultValue;
  }

  /**
   * Set configuration value
   */
  setConfig(key, value) {
    this.config[key] = value;
    this.emit('config:changed', { key, value });
  }

  /**
   * Log message through skill logger
   */
  log(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      skillId: this.skillId,
      level,
      message,
      ...meta
    };

    // Emit log event
    this.emit('log', entry);

    // Also log to console in development
    if (process.env.NODE_ENV === 'development') {
      console[level] || console.log;
      (console[level] || console.log)(`[${this.skillId}] ${message}`, meta);
    }

    return entry;
  }

  /**
   * Error logging
   */
  error(message, error) {
    return this.log('error', message, {
      error: error?.message,
      stack: error?.stack
    });
  }

  /**
   * Warning logging
   */
  warn(message, meta = {}) {
    return this.log('warn', message, meta);
  }

  /**
   * Info logging
   */
  info(message, meta = {}) {
    return this.log('info', message, meta);
  }

  /**
   * Debug logging
   */
  debug(message, meta = {}) {
    if (this.getConfig('debug', false)) {
      return this.log('debug', message, meta);
    }
  }

  /**
   * Call another skill
   */
  async callSkill(skillId, capability, args = {}) {
    if (!this.registry) {
      throw new Error('Registry not available');
    }

    return await this.registry.execute(skillId, capability, args, {
      caller: this.skillId
    });
  }

  /**
   * Emit event through registry
   */
  emitEvent(event, data) {
    this.emit(event, data);

    if (this.registry) {
      this.registry.emit(`skill:${this.skillId}:${event}`, data);
    }
  }

  /**
   * Register a hook
   */
  registerHook(event, handler, priority = 0) {
    if (this.registry) {
      this.registry.registerHook(event, handler, priority);
    }
  }

  /**
   * Check if skill has permission
   */
  hasPermission(permission) {
    const permissions = this.manifest.permissions || [];
    return permissions.includes(permission) || permissions.includes('*');
  }

  /**
   * Get capabilities this skill provides
   */
  getCapabilities() {
    const caps = this.manifest.capabilities || [];

    // Auto-detect from methods
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
      .filter(name =>
        name !== 'constructor' &&
        typeof this[name] === 'function' &&
        !name.startsWith('_')
      );

    return [...new Set([...caps, ...methods])];
  }

  /**
   * Health check
   */
  async healthCheck() {
    return {
      skillId: this.skillId,
      status: this.status,
      initialized: this.initialized,
      healthy: this.initialized && this.status === 'active',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      skillId: this.skillId,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
  }
}

export default BaseSkill;
