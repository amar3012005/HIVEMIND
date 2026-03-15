/**
 * HIVE-MIND Skill Sandbox
 * Secure execution environment for skills with resource limits and permission controls
 */

import { EventEmitter } from 'events';
import { createContext, runInContext } from 'vm';

export class SkillSandbox extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      timeout: options.timeout || 30000,
      memoryLimit: options.memoryLimit || 128 * 1024 * 1024, // 128MB
      cpuLimit: options.cpuLimit || 1000, // ms
      allowNetwork: options.allowNetwork || false,
      allowFileSystem: options.allowFileSystem || false,
      allowChildProcess: options.allowChildProcess || false,
      ...options
    };
    this.running = new Map();
  }

  /**
   * Create isolated context for skill execution
   */
  createContext(skillId, manifest) {
    const allowedAPIs = manifest.apis || ['memory', 'graph'];

    // Build API proxy
    const api = {};
    for (const apiName of allowedAPIs) {
      api[apiName] = this.createAPIProxy(skillId, apiName);
    }

    // Create sandbox context
    const sandbox = {
      // Limited console
      console: this.createSafeConsole(skillId),

      // Allowed APIs
      hivemind: api,

      // Utility functions
      setTimeout: (fn, delay) => setTimeout(fn, delay),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, delay) => setInterval(fn, delay),
      clearInterval: (id) => clearInterval(id),

      // Safe Date
      Date: Date,

      // Safe Math
      Math: Math,

      // Safe JSON
      JSON: JSON,

      // TextEncoder/Decoder
      TextEncoder: TextEncoder,
      TextDecoder: TextDecoder,

      // Safe error constructors
      Error: Error,
      TypeError: TypeError,
      RangeError: RangeError,
      SyntaxError: SyntaxError,
      ReferenceError: ReferenceError,

      // Process info (limited)
      process: {
        env: {},
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryUsage: () => process.memoryUsage()
      }
    };

    // Add memory API if allowed
    if (allowedAPIs.includes('memory')) {
      sandbox.hivemind.memory = this.createMemoryAPI(skillId);
    }

    // Add graph API if allowed
    if (allowedAPIs.includes('graph')) {
      sandbox.hivemind.graph = this.createGraphAPI(skillId);
    }

    // Add recall API if allowed
    if (allowedAPIs.includes('recall')) {
      sandbox.hivemind.recall = this.createRecallAPI(skillId);
    }

    // Add store API if allowed
    if (allowedAPIs.includes('store')) {
      sandbox.hivemind.store = this.createStoreAPI(skillId);
    }

    return createContext(sandbox);
  }

  /**
   * Create API proxy with permission checks
   */
  createAPIProxy(skillId, apiName) {
    return new Proxy({}, {
      get: (target, prop) => {
        return async (...args) => {
          // Log API call
          this.emit('api:call', {
            skillId,
            api: apiName,
            method: prop,
            args: this.sanitizeArgs(args)
          });

          // Check permission
          if (!await this.checkPermission(skillId, apiName, prop)) {
            throw new Error(`Permission denied: ${apiName}.${prop}`);
          }

          // Execute with timeout
          return await this.executeWithTimeout(
            () => this.registry.execute(skillId, apiName, prop, args),
            this.options.timeout
          );
        };
      }
    });
  }

  /**
   * Create safe console that logs to system
   */
  createSafeConsole(skillId) {
    const prefix = `[${skillId}]`;
    return {
      log: (...args) => {
        console.log(prefix, ...args);
        this.emit('console:log', { skillId, level: 'log', args });
      },
      warn: (...args) => {
        console.warn(prefix, ...args);
        this.emit('console:warn', { skillId, level: 'warn', args });
      },
      error: (...args) => {
        console.error(prefix, ...args);
        this.emit('console:error', { skillId, level: 'error', args });
      },
      info: (...args) => {
        console.info(prefix, ...args);
        this.emit('console:info', { skillId, level: 'info', args });
      },
      debug: (...args) => {
        if (this.options.debug) {
          console.debug(prefix, ...args);
          this.emit('console:debug', { skillId, level: 'debug', args });
        }
      }
    };
  }

  /**
   * Create memory API
   */
  createMemoryAPI(skillId) {
    return {
      store: async (content, metadata = {}) => {
        return await this.callMemoryService('store', {
          content,
          metadata: { ...metadata, sourceSkill: skillId }
        });
      },

      recall: async (query, options = {}) => {
        return await this.callMemoryService('recall', {
          query,
          filter: { sourceSkill: skillId, ...options.filter }
        });
      },

      update: async (id, updates) => {
        return await this.callMemoryService('update', { id, updates });
      },

      forget: async (id) => {
        return await this.callMemoryService('forget', { id });
      },

      traverse: async (startId, options = {}) => {
        return await this.callMemoryService('traverse', {
          startId,
          depth: options.depth || 3,
          relationshipTypes: options.relationshipTypes
        });
      }
    };
  }

  /**
   * Create graph API
   */
  createGraphAPI(skillId) {
    return {
      createNode: async (data) => {
        return await this.callGraphService('createNode', {
          ...data,
          metadata: { sourceSkill: skillId, ...data.metadata }
        });
      },

      createEdge: async (from, to, type, metadata = {}) => {
        return await this.callGraphService('createEdge', {
          from,
          to,
          type,
          metadata: { sourceSkill: skillId, ...metadata }
        });
      },

      search: async (query, options = {}) => {
        return await this.callGraphService('search', {
          query,
          filter: { sourceSkill: skillId, ...options.filter }
        });
      },

      getNode: async (id) => {
        return await this.callGraphService('getNode', { id });
      },

      getEdges: async (id, direction = 'both') => {
        return await this.callGraphService('getEdges', { id, direction });
      }
    };
  }

  /**
   * Create recall API
   */
  createRecallAPI(skillId) {
    return {
      quick: async (query, options = {}) => {
        return await this.callRecallService('quick', {
          query,
          ...options
        });
      },

      panorama: async (query, options = {}) => {
        return await this.callRecallService('panorama', {
          query,
          ...options
        });
      },

      insight: async (query, options = {}) => {
        return await this.callRecallService('insight', {
          query,
          ...options
        });
      },

      interview: async (entityId) => {
        return await this.callRecallService('interview', { entityId });
      }
    };
  }

  /**
   * Create store API
   */
  createStoreAPI(skillId) {
    return {
      get: async (key) => {
        return await this.callStoreService('get', {
          key: `${skillId}:${key}`
        });
      },

      set: async (key, value, ttl) => {
        return await this.callStoreService('set', {
          key: `${skillId}:${key}`,
          value,
          ttl
        });
      },

      delete: async (key) => {
        return await this.callStoreService('delete', {
          key: `${skillId}:${key}`
        });
      },

      list: async (pattern = '*') => {
        return await this.callStoreService('list', {
          pattern: `${skillId}:${pattern}`
        });
      }
    };
  }

  /**
   * Execute code with timeout
   */
  async executeWithTimeout(fn, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution timeout after ${timeout}ms`));
      }, timeout);

      Promise.resolve(fn())
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Check if skill has permission
   */
  async checkPermission(skillId, api, method) {
    const meta = this.registry?.getSkill(skillId);
    if (!meta) return false;

    const permissions = meta.manifest.permissions || [];

    // Check if permission is granted
    return permissions.some(p =>
      p === '*' ||
      p === api ||
      p === `${api}:${method}`
    );
  }

  /**
   * Sanitize arguments for logging
   */
  sanitizeArgs(args) {
    return args.map(arg => {
      if (typeof arg === 'object') {
        // Remove sensitive data
        const safe = { ...arg };
        delete safe.password;
        delete safe.token;
        delete safe.secret;
        delete safe.apiKey;
        return safe;
      }
      return arg;
    });
  }

  /**
   * Execute skill code in sandbox
   */
  async execute(skillId, code, context = {}) {
    const meta = this.registry?.getSkill(skillId);
    if (!meta) throw new Error(`Skill not found: ${skillId}`);

    // Create sandbox
    const sandbox = this.createContext(skillId, meta.manifest);

    // Merge context
    Object.assign(sandbox, context);

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(
        () => runInContext(code, sandbox, {
          timeout: this.options.timeout,
          displayErrors: true
        }),
        this.options.timeout
      );

      return result;
    } catch (err) {
      this.emit('execution:error', { skillId, error: err.message });
      throw err;
    }
  }

  /**
   * Set registry reference
   */
  setRegistry(registry) {
    this.registry = registry;
  }

  /**
   * Service call helpers (to be implemented with actual services)
   */
  async callMemoryService(method, args) {
    // This would connect to the actual memory service
    throw new Error('Memory service not connected');
  }

  async callGraphService(method, args) {
    throw new Error('Graph service not connected');
  }

  async callRecallService(method, args) {
    throw new Error('Recall service not connected');
  }

  async callStoreService(method, args) {
    throw new Error('Store service not connected');
  }
}

export default SkillSandbox;
