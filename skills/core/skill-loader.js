/**
 * HIVE-MIND Skill Loader
 * Dynamic skill loading with hot reload and dependency resolution
 */

import { readFile, watch } from 'fs/promises';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

export class SkillLoader {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.options = options;
    this.cache = new Map();
    this.watching = new Map();
    this.dependencyGraph = new Map();
    this.hotReload = options.hotReload !== false;
  }

  /**
   * Load a skill module with caching
   */
  async load(skillId) {
    const meta = this.registry.getSkill(skillId);
    if (!meta) throw new Error(`Skill not found: ${skillId}`);

    const entryPath = resolve(meta.path, meta.manifest.entry || 'index.js');
    const cacheKey = `${skillId}:${entryPath}`;

    // Check cache
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Clear import cache for hot reload
      const modulePath = pathToFileURL(entryPath).href;

      // Load module
      const module = await import(modulePath);

      // Cache
      this.cache.set(cacheKey, module);

      // Setup watch for hot reload
      if (this.hotReload && !this.watching.has(cacheKey)) {
        this.setupWatch(skillId, meta.path);
      }

      return module;
    } catch (err) {
      throw new Error(`Failed to load skill ${skillId}: ${err.message}`);
    }
  }

  /**
   * Setup file watching for hot reload
   */
  async setupWatch(skillId, skillPath) {
    if (!this.hotReload) return;

    try {
      const watcher = watch(skillPath, { recursive: true });
      this.watching.set(skillId, watcher);

      // Watch loop
      (async () => {
        for await (const event of watcher) {
          if (event.filename?.endsWith('.js')) {
            this.emit('skill:changed', { skillId, file: event.filename });
            await this.reload(skillId);
          }
        }
      })();
    } catch (err) {
      console.warn(`Could not watch skill ${skillId}:`, err.message);
    }
  }

  /**
   * Reload a skill (hot reload)
   */
  async reload(skillId) {
    const meta = this.registry.getSkill(skillId);
    if (!meta) return;

    // Clear cache
    const entryPath = resolve(meta.path, meta.manifest.entry || 'index.js');
    const cacheKey = `${skillId}:${entryPath}`;
    this.cache.delete(cacheKey);

    // Deactivate and reactivate
    await this.registry.deactivateSkill(skillId);
    await this.registry.activateSkill(skillId);

    this.emit('skill:reloaded', { skillId });
  }

  /**
   * Resolve skill dependencies
   */
  async resolveDependencies(skillId) {
    const meta = this.registry.getSkill(skillId);
    if (!meta) throw new Error(`Skill not found: ${skillId}`);

    const deps = meta.manifest.dependencies || {};
    const resolved = [];

    for (const [depId, versionRange] of Object.entries(deps)) {
      const depMeta = this.findDependency(depId, versionRange);
      if (!depMeta) {
        throw new Error(`Dependency not found: ${depId}@${versionRange} required by ${skillId}`);
      }
      resolved.push(depMeta);
    }

    this.dependencyGraph.set(skillId, resolved.map(d => d.id));
    return resolved;
  }

  /**
   * Find a dependency by ID and version range
   */
  findDependency(depId, versionRange) {
    // Check built-in
    const builtin = this.registry.listSkills().find(s => s.id === depId && s.builtin);
    if (builtin) return builtin;

    // Check installed
    const installed = this.registry.listSkills().find(s => s.id === depId && s.userInstalled);
    if (installed && this.satisfiesVersion(installed.version, versionRange)) {
      return installed;
    }

    return null;
  }

  /**
   * Check if version satisfies range
   */
  satisfiesVersion(version, range) {
    // Simple semver check
    if (range === '*' || range === 'latest') return true;

    // TODO: Implement proper semver parsing
    return true;
  }

  /**
   * Load skills in dependency order
   */
  async loadInOrder(skillIds) {
    const loaded = new Set();
    const order = [];

    const visit = (id) => {
      if (loaded.has(id)) return;
      loaded.add(id);

      const deps = this.dependencyGraph.get(id) || [];
      for (const depId of deps) {
        visit(depId);
      }

      order.push(id);
    };

    for (const skillId of skillIds) {
      await this.resolveDependencies(skillId);
      visit(skillId);
    }

    return order;
  }

  /**
   * Unload a skill
   */
  async unload(skillId) {
    // Stop watching
    const watcher = this.watching.get(skillId);
    if (watcher) {
      await watcher.close();
      this.watching.delete(skillId);
    }

    // Clear cache
    const meta = this.registry.getSkill(skillId);
    if (meta) {
      const entryPath = resolve(meta.path, meta.manifest.entry || 'index.js');
      const cacheKey = `${skillId}:${entryPath}`;
      this.cache.delete(cacheKey);
    }

    // Clear from dependency graph
    this.dependencyGraph.delete(skillId);
  }

  /**
   * Get all skills that depend on a given skill
   */
  getDependents(skillId) {
    const dependents = [];

    for (const [id, deps] of this.dependencyGraph.entries()) {
      if (deps.includes(skillId)) {
        dependents.push(id);
      }
    }

    return dependents;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Cleanup
   */
  async destroy() {
    for (const [skillId, watcher] of this.watching) {
      await watcher.close();
    }
    this.watching.clear();
    this.cache.clear();
    this.dependencyGraph.clear();
  }

  emit(event, data) {
    if (this.registry) {
      this.registry.emit(event, data);
    }
  }
}

export default SkillLoader;
