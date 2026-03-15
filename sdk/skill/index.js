/**
 * HIVE-MIND Skill SDK
 * Utilities for skill development
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Create a new skill from template
 */
export async function createSkillFromTemplate(name, options = {}) {
  const template = options.template || 'basic';
  const directory = options.directory || './skills/custom';
  const skillPath = resolve(directory, name);

  // Create directory
  if (!existsSync(skillPath)) {
    await mkdir(skillPath, { recursive: true });
  }

  // Generate skill.json
  const manifest = generateManifest(name, template, options);
  await writeFile(
    join(skillPath, 'skill.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Generate index.js
  const code = generateSkillCode(name, template, manifest);
  await writeFile(join(skillPath, 'index.js'), code);

  // Generate README
  const readme = generateReadme(name, manifest);
  await writeFile(join(skillPath, 'README.md'), readme);

  // Generate test file
  const test = generateTest(name, manifest);
  await writeFile(join(skillPath, 'test.js'), test);

  return skillPath;
}

/**
 * Generate skill manifest
 */
function generateManifest(name, template, options) {
  const templates = {
    basic: {
      type: 'utility',
      capabilities: ['hello', 'echo'],
      permissions: ['memory:read'],
      apis: ['memory']
    },
    analysis: {
      type: 'analysis',
      capabilities: ['analyze', 'report'],
      permissions: ['memory:read', 'recall:quick'],
      apis: ['memory', 'recall']
    },
    integration: {
      type: 'integration',
      capabilities: ['connect', 'sync', 'import'],
      permissions: ['memory:write', 'memory:read'],
      apis: ['memory', 'graph']
    }
  };

  const templateConfig = templates[template] || templates.basic;

  return {
    name: options.name || name,
    version: options.version || '1.0.0',
    description: options.description || `A ${template} skill for HIVE-MIND`,
    type: templateConfig.type,
    author: options.author || 'Anonymous',
    license: options.license || 'MIT',
    entry: 'index.js',
    capabilities: templateConfig.capabilities,
    permissions: templateConfig.permissions,
    apis: templateConfig.apis,
    config: options.config || {},
    dependencies: options.dependencies || {},
    tags: options.tags || [template]
  };
}

/**
 * Generate skill code
 */
function generateSkillCode(name, template, manifest) {
  const className = name.replace(/[-_]/g, '').replace(/^[a-z]/, c => c.toUpperCase()) + 'Skill';

  return `/**
 * ${manifest.name}
 * ${manifest.description}
 */

import { BaseSkill } from '${getRelativePath(template)}/core/base-skill.js';

export default class ${className} extends BaseSkill {
  constructor(options) {
    super(options);
  }

  async initialize() {
    this.info('Initializing ${manifest.name}');
    await super.initialize();
  }

${manifest.capabilities.map(cap => generateCapability(cap)).join('\n')}
}
`;
}

/**
 * Generate a capability method
 */
function generateCapability(name) {
  return `
  /**
   * ${name} capability
   */
  async ${name}(args = {}) {
    this.info('Executing ${name}', args);

    // TODO: Implement ${name} logic

    return {
      success: true,
      capability: '${name}',
      timestamp: new Date().toISOString()
    };
  }
`;
}

/**
 * Get relative path to core
 */
function getRelativePath(template) {
  // Adjust based on where the skill is created
  return '../../core';
}

/**
 * Generate README
 */
function generateReadme(name, manifest) {
  return `# ${manifest.name}

${manifest.description}

## Installation

\`\`\`bash
hivemind-skills install ./skills/custom/${name}
\`\`\`

## Capabilities

${manifest.capabilities.map(cap => `- \`${cap}\``).join('\n')}

## Configuration

\`\`\`json
${JSON.stringify(manifest.config, null, 2)}
\`\`\`

## Usage

\`\`\`javascript
// Execute capability
const result = await skill.${manifest.capabilities[0]}({
  // args
});
\`\`\`

## Permissions

${manifest.permissions.map(p => `- ${p}`).join('\n')}

## License

${manifest.license}
`;
}

/**
 * Generate test file
 */
function generateTest(name, manifest) {
  return `/**
 * Tests for ${manifest.name}
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import ${name}Skill from './index.js';

describe('${manifest.name}', () => {
  let skill;

  beforeEach(() => {
    skill = new ${name}Skill({
      skillId: 'test-${name}',
      manifest: {
        name: '${manifest.name}',
        version: '${manifest.version}',
        capabilities: ${JSON.stringify(manifest.capabilities)}
      }
    });
  });

${manifest.capabilities.map(cap => generateTestCase(cap)).join('\n')}
});
`;
}

/**
 * Generate a test case
 */
function generateTestCase(name) {
  return `
  describe('${name}', () => {
    it('should execute successfully', async () => {
      const result = await skill.${name}({});
      expect(result.success).toBe(true);
      expect(result.capability).toBe('${name}');
    });
  });
`;
}

/**
 * Validate skill manifest
 */
export async function validateSkillManifest(skillPath) {
  const manifestPath = join(skillPath, 'skill.json');
  const indexPath = join(skillPath, 'index.js');

  // Check files exist
  if (!existsSync(manifestPath)) {
    throw new Error('skill.json not found');
  }

  if (!existsSync(indexPath)) {
    throw new Error('index.js not found');
  }

  // Read and parse manifest
  const data = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(data);

  // Validate required fields
  const required = ['name', 'version', 'type', 'entry'];
  const missing = required.filter(f => !manifest[f]);

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }

  // Validate version format (semver-ish)
  const versionRegex = /^\d+\.\d+\.\d+/;
  if (!versionRegex.test(manifest.version)) {
    throw new Error('Invalid version format (expected: x.y.z)');
  }

  // Validate type
  const validTypes = ['utility', 'analysis', 'integration', 'ingestion', 'query', 'visualization'];
  if (!validTypes.includes(manifest.type)) {
    throw new Error(`Invalid type: ${manifest.type}. Must be one of: ${validTypes.join(', ')}`);
  }

  return {
    valid: true,
    manifest,
    warnings: []
  };
}

/**
 * Package skill for distribution
 */
export async function packageSkill(skillPath, outputPath) {
  const { valid, manifest } = await validateSkillManifest(skillPath);

  if (!valid) {
    throw new Error('Invalid skill manifest');
  }

  // Create package
  const packageData = {
    manifest,
    files: {},
    packagedAt: new Date().toISOString()
  };

  // Read all files
  // (In real implementation, would read all .js, .json, .md files)

  // Write package
  await writeFile(outputPath, JSON.stringify(packageData, null, 2));

  return outputPath;
}

/**
 * Publish skill to marketplace
 */
export async function publishSkill(skillPath, marketplaceConfig) {
  // Validate
  await validateSkillManifest(skillPath);

  // Package
  const packageName = `skill-${Date.now()}.json`;
  const packagePath = join('./dist', packageName);
  await packageSkill(skillPath, packagePath);

  // Upload to marketplace
  // (In real implementation, would upload to marketplace API)

  return {
    published: true,
    packagePath,
    marketplaceUrl: marketplaceConfig.url
  };
}

export default {
  createSkillFromTemplate,
  validateSkillManifest,
  packageSkill,
  publishSkill
};
