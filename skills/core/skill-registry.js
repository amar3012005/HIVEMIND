/**
 * HIVE-MIND Skill Registry
 * Central hub for skill registration, discovery, and lifecycle management
 */

import { EventEmitter } from 'events';
import { readFile, readdir, access } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

export class SkillRegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.skillsDir = options.skillsDir || './skills';
    this.marketplaceDir = options.marketplaceDir || './marketplace/skills';
    this.registry = new Map();
    this.instances = new Map();
    this.permissions = new Map();
    this.hooks = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the skill registry
   */
  async initialize() {
    if (this.initialized) return;

    // Load built-in skills
    await this.loadBuiltinSkills();

    // Load user-installed skills
    await this.loadUserSkills();

    // Load marketplace catalog
    await this.loadMarketplaceCatalog();

    this.initialized = true;
    this.emit('initialized', { skillCount: this.registry.size });
  }

  /**
   * Load built-in skills from the system
   */
  async loadBuiltinSkills() {
    const builtinPath = resolve(this.skillsDir, 'builtin');

    try {
      const entries = await readdir(builtinPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.registerSkillFromPath(join(builtinPath, entry.name), { builtin: true });
        }
      }
    } catch (err) {
      // Built-in skills directory may not exist
    }
  }

  /**
   * Load user-installed skills
   */
  async loadUserSkills() {
    const registryPath = resolve(this.skillsDir, 'registry', 'installed.json');

    try {
      const data = await readFile(registryPath, 'utf-8');
      const installed = JSON.parse(data);

      for (const skillId of installed.skills) {
        const skillPath = resolve(this.skillsDir, 'registry', skillId);
        await this.registerSkillFromPath(skillPath, { userInstalled: true });
      }
    } catch (err) {
      // No installed skills yet
    }
  }

  /**
   * Load marketplace catalog
   */
  async loadMarketplaceCatalog() {
    const catalogPath = resolve(this.marketplaceDir, 'catalog.json');

    try {
      const data = await readFile(catalogPath, 'utf-8');
      this.marketplaceCatalog = JSON.parse(data);
    } catch (err) {
      this.marketplaceCatalog = { skills: [], lastUpdated: null };
    }
  }

  /**
   * Register a skill from a directory path
   */
  async registerSkillFromPath(skillPath, options = {}) {
    const manifestPath = join(skillPath, 'skill.json');

    try {
      const data = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(data);

      // Validate manifest
      if (!this.validateManifest(manifest)) {
        throw new Error(`Invalid skill manifest: ${manifestPath}`);
      }

      // Generate skill ID
      const skillId = manifest.id || this.generateSkillId(manifest.name);

      // Store skill metadata
      const skillMeta = {
        id: skillId,
        path: skillPath,
        manifest,
        ...options,
        registeredAt: new Date().toISOString(),
        status: 'registered'
      };

      this.registry.set(skillId, skillMeta);
      this.emit('skill:registered', skillMeta);

      return skillId;
    } catch (err) {
      this.emit('skill:error', { path: skillPath, error: err.message });
      return null;
    }
  }

  /**
   * Validate skill manifest
   */
  validateManifest(manifest) {
    const required = ['name', 'version', 'type'];
    return required.every(field => manifest[field]);
  }

  /**
   * Generate unique skill ID
   */
  generateSkillId(name) {
    const hash = createHash('sha256').update(name).digest('hex');
    return `skill_${hash.slice(0, 12)}`;
  }

  /**
   * Activate a skill (load and initialize)
   */
  async activateSkill(skillId, context = {}) {
    const meta = this.registry.get(skillId);
    if (!meta) throw new Error(`Skill not found: ${skillId}`);

    if (this.instances.has(skillId)) {
      return this.instances.get(skillId);
    }

    try {
      // Load skill module
      const entryPath = resolve(meta.path, meta.manifest.entry || 'index.js');
      const { default: SkillClass } = await import(entryPath);

      // Create instance with context
      const instance = new SkillClass({
        ...context,
        skillId,
        manifest: meta.manifest,
        registry: this
      });

      // Initialize
      if (instance.initialize) {
        await instance.initialize();
      }

      this.instances.set(skillId, instance);
      meta.status = 'active';
      meta.activatedAt = new Date().toISOString();

      this.emit('skill:activated', { skillId, instance });

      return instance;
    } catch (err) {
      meta.status = 'error';
      meta.error = err.message;
      this.emit('skill:error', { skillId, error: err.message });
      throw err;
    }
  }

  /**
   * Deactivate a skill
   */
  async deactivateSkill(skillId) {
    const instance = this.instances.get(skillId);
    if (!instance) return;

    if (instance.destroy) {
      await instance.destroy();
    }

    this.instances.delete(skillId);

    const meta = this.registry.get(skillId);
    if (meta) {
      meta.status = 'registered';
      delete meta.activatedAt;
    }

    this.emit('skill:deactivated', { skillId });
  }

  /**
   * Execute a skill capability
   */
  async execute(skillId, capability, args = {}, context = {}) {
    const instance = await this.activateSkill(skillId, context);

    if (!instance[capability]) {
      throw new Error(`Capability not found: ${capability} in skill ${skillId}`);
    }

    // Check permissions
    await this.checkPermission(skillId, capability, context);

    return await instance[capability](args);
  }

  /**
   * Check if skill has permission to execute capability
   */
  async checkPermission(skillId, capability, context) {
    const perms = this.permissions.get(skillId) || [];
    const required = ['execute', capability];

    // TODO: Implement permission checking logic
    return true;
  }

  /**
   * Install a skill from marketplace
   */
  async installSkill(skillId, options = {}) {
    const skill = this.marketplaceCatalog.skills.find(s => s.id === skillId);
    if (!skill) throw new Error(`Skill not found in marketplace: ${skillId}`);

    // Download and install
    const installPath = resolve(this.skillsDir, 'registry', skillId);

    // TODO: Implement download from marketplace

    // Register
    await this.registerSkillFromPath(installPath, { userInstalled: true });

    // Update installed list
    await this.saveInstalledList();

    this.emit('skill:installed', { skillId, path: installPath });

    return skillId;
  }

  /**
   * Uninstall a skill
   */
  async uninstallSkill(skillId) {
    const meta = this.registry.get(skillId);
    if (!meta) throw new Error(`Skill not found: ${skillId}`);

    if (!meta.userInstalled) {
      throw new Error(`Cannot uninstall built-in skill: ${skillId}`);
    }

    // Deactivate first
    await this.deactivateSkill(skillId);

    // Remove from registry
    this.registry.delete(skillId);
    this.permissions.delete(skillId);

    // Update installed list
    await this.saveInstalledList();

    this.emit('skill:uninstalled', { skillId });
  }

  /**
   * Save list of installed skills
   */
  async saveInstalledList() {
    const installed = {
      skills: Array.from(this.registry.entries())
        .filter(([_, meta]) => meta.userInstalled)
        .map(([id]) => id),
      updatedAt: new Date().toISOString()
    };

    const registryPath = resolve(this.skillsDir, 'registry', 'installed.json');
    await Bun.write(registryPath, JSON.stringify(installed, null, 2));
  }

  /**
   * Get skill info
   */
  getSkill(skillId) {
    return this.registry.get(skillId);
  }

  /**
   * List all registered skills
   */
  listSkills(options = {}) {
    const skills = Array.from(this.registry.entries()).map(([id, meta]) => ({
      id,
      ...meta.manifest,
      status: meta.status,
      builtin: meta.builtin,
      userInstalled: meta.userInstalled
    }));

    if (options.filter) {
      return skills.filter(s => options.filter(s));
    }

    return skills;
  }

  /**
   * Search marketplace for skills
   */
  searchMarketplace(query, options = {}) {
    if (!this.marketplaceCatalog.skills) return [];

    return this.marketplaceCatalog.skills.filter(skill => {
      const matches =
        skill.name?.toLowerCase().includes(query.toLowerCase()) ||
        skill.description?.toLowerCase().includes(query.toLowerCase()) ||
        skill.tags?.some(tag => tag.toLowerCase().includes(query.toLowerCase()));

      return matches;
    });
  }

  /**
   * Register a hook
   */
  registerHook(event, handler, priority = 0) {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }

    const handlers = this.hooks.get(event);
    handlers.push({ handler, priority });
    handlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Execute hooks
   */
  async executeHooks(event, data) {
    const handlers = this.hooks.get(event) || [];
    let result = data;

    for (const { handler } of handlers) {
      result = await handler(result) || result;
    }

    return result;
  }

  /**
   * Get all active skill instances
   */
  getActiveSkills() {
    return Array.from(this.instances.entries()).map(([id, instance]) => ({
      id,
      instance,
      manifest: this.registry.get(id)?.manifest
    }));
  }

  /**
   * Shutdown all skills
   */
  async shutdown() {
    for (const [skillId] of this.instances) {
      await this.deactivateSkill(skillId);
    }

    this.initialized = false;
    this.emit('shutdown');
  }
}

export default SkillRegistry;
