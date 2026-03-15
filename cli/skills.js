#!/usr/bin/env node
/**
 * HIVE-MIND Skill CLI
 * Command-line interface for skill management
 */

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { SkillRegistry } from '../skills/core/skill-registry.js';
import { SkillLoader } from '../skills/core/skill-loader.js';
import { SkillSandbox } from '../skills/core/sandbox.js';

const program = new Command();
const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf-8'));

// Initialize registry
const registry = new SkillRegistry({
  skillsDir: resolve(process.cwd(), 'skills'),
  marketplaceDir: resolve(process.cwd(), 'marketplace/skills')
});

const loader = new SkillLoader(registry);
const sandbox = new SkillSandbox();

program
  .name('hivemind-skills')
  .description('HIVE-MIND Skill Management CLI')
  .version(packageJson.version);

// List command
program
  .command('list')
  .description('List all installed skills')
  .option('-a, --all', 'Include built-in skills')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    await registry.initialize();

    let skills = registry.listSkills();

    if (!options.all) {
      skills = skills.filter(s => s.userInstalled);
    }

    if (options.json) {
      console.log(JSON.stringify(skills, null, 2));
    } else {
      console.log('\n📦 Installed Skills\n');

      if (skills.length === 0) {
        console.log('No skills installed. Use `hivemind-skills install <skill>` to add skills.\n');
        return;
      }

      for (const skill of skills) {
        const badge = skill.builtin ? '🔧' : '📦';
        const status = skill.status === 'active' ? '✅' : '⏸️';
        console.log(`${badge} ${status} ${skill.name}@${skill.version}`);
        console.log(`   ${skill.description || 'No description'}`);
        console.log(`   ID: ${skill.id}\n`);
      }
    }
  });

// Search command
program
  .command('search <query>')
  .description('Search marketplace for skills')
  .option('-j, --json', 'Output as JSON')
  .action(async (query, options) => {
    await registry.initialize();

    const results = registry.searchMarketplace(query);

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`\n🔍 Marketplace Search: "${query}"\n`);

      if (results.length === 0) {
        console.log('No skills found.\n');
        return;
      }

      for (const skill of results) {
        console.log(`📦 ${skill.name}@${skill.version}`);
        console.log(`   ${skill.description || 'No description'}`);
        console.log(`   Author: ${skill.author || 'Unknown'}`);
        console.log(`   Install: hivemind-skills install ${skill.id}\n`);
      }
    }
  });

// Install command
program
  .command('install <skillId>')
  .description('Install a skill from the marketplace')
  .option('-v, --version <version>', 'Specific version to install')
  .action(async (skillId, options) => {
    await registry.initialize();

    console.log(`📥 Installing ${skillId}...`);

    try {
      const installed = await registry.installSkill(skillId, options);
      console.log(`✅ Successfully installed ${installed}`);
    } catch (err) {
      console.error(`❌ Installation failed: ${err.message}`);
      process.exit(1);
    }
  });

// Uninstall command
program
  .command('uninstall <skillId>')
  .description('Uninstall a skill')
  .action(async (skillId) => {
    await registry.initialize();

    console.log(`🗑️  Uninstalling ${skillId}...`);

    try {
      await registry.uninstallSkill(skillId);
      console.log(`✅ Successfully uninstalled ${skillId}`);
    } catch (err) {
      console.error(`❌ Uninstall failed: ${err.message}`);
      process.exit(1);
    }
  });

// Activate command
program
  .command('activate <skillId>')
  .description('Activate a skill')
  .action(async (skillId) => {
    await registry.initialize();

    console.log(`▶️  Activating ${skillId}...`);

    try {
      await registry.activateSkill(skillId);
      console.log(`✅ Successfully activated ${skillId}`);
    } catch (err) {
      console.error(`❌ Activation failed: ${err.message}`);
      process.exit(1);
    }
  });

// Deactivate command
program
  .command('deactivate <skillId>')
  .description('Deactivate a skill')
  .action(async (skillId) => {
    await registry.initialize();

    console.log(`⏸️  Deactivating ${skillId}...`);

    try {
      await registry.deactivateSkill(skillId);
      console.log(`✅ Successfully deactivated ${skillId}`);
    } catch (err) {
      console.error(`❌ Deactivation failed: ${err.message}`);
      process.exit(1);
    }
  });

// Info command
program
  .command('info <skillId>')
  .description('Show detailed info about a skill')
  .option('-j, --json', 'Output as JSON')
  .action(async (skillId, options) => {
    await registry.initialize();

    const skill = registry.getSkill(skillId);

    if (!skill) {
      console.error(`❌ Skill not found: ${skillId}`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(skill, null, 2));
    } else {
      console.log(`\n📋 Skill Information\n`);
      console.log(`Name: ${skill.manifest.name}`);
      console.log(`ID: ${skill.id}`);
      console.log(`Version: ${skill.manifest.version}`);
      console.log(`Status: ${skill.status}`);
      console.log(`Type: ${skill.builtin ? 'Built-in' : 'User-installed'}`);
      console.log(`Description: ${skill.manifest.description || 'N/A'}`);
      console.log(`Author: ${skill.manifest.author || 'N/A'}`);

      if (skill.manifest.capabilities?.length) {
        console.log(`\nCapabilities:`);
        for (const cap of skill.manifest.capabilities) {
          console.log(`  • ${cap}`);
        }
      }

      if (skill.manifest.permissions?.length) {
        console.log(`\nPermissions:`);
        for (const perm of skill.manifest.permissions) {
          console.log(`  • ${perm}`);
        }
      }

      if (skill.manifest.dependencies) {
        console.log(`\nDependencies:`);
        for (const [dep, version] of Object.entries(skill.manifest.dependencies)) {
          console.log(`  • ${dep}@${version}`);
        }
      }

      console.log();
    }
  });

// Execute command
program
  .command('exec <skillId> <capability>')
  .description('Execute a skill capability')
  .option('-a, --args <json>', 'JSON arguments', '{}')
  .action(async (skillId, capability, options) => {
    await registry.initialize();

    let args;
    try {
      args = JSON.parse(options.args);
    } catch (err) {
      console.error(`❌ Invalid JSON arguments: ${err.message}`);
      process.exit(1);
    }

    console.log(`⚡ Executing ${skillId}.${capability}...\n`);

    try {
      const result = await registry.execute(skillId, capability, args);
      console.log('Result:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`❌ Execution failed: ${err.message}`);
      process.exit(1);
    }
  });

// Create command
program
  .command('create <name>')
  .description('Create a new skill from template')
  .option('-d, --directory <dir>', 'Output directory', './skills/custom')
  .option('-t, --template <template>', 'Template to use', 'basic')
  .action(async (name, options) => {
    console.log(`🆕 Creating skill "${name}" from template "${options.template}"...`);

    const { createSkillFromTemplate } = await import('../sdk/skill/index.js');

    try {
      const skillPath = await createSkillFromTemplate(name, options);
      console.log(`✅ Skill created at: ${skillPath}`);
      console.log(`\nNext steps:`);
      console.log(`  1. cd ${skillPath}`);
      console.log(`  2. Edit skill.json to customize`);
      console.log(`  3. Implement your logic in index.js`);
      console.log(`  4. hivemind-skills install ${skillPath}`);
    } catch (err) {
      console.error(`❌ Creation failed: ${err.message}`);
      process.exit(1);
    }
  });

// Validate command
program
  .command('validate <path>')
  .description('Validate a skill manifest')
  .action(async (skillPath) => {
    const { validateSkillManifest } = await import('../sdk/skill/index.js');

    try {
      const result = await validateSkillManifest(resolve(skillPath));
      console.log('✅ Valid skill manifest');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`❌ Validation failed: ${err.message}`);
      process.exit(1);
    }
  });

// Health command
program
  .command('health')
  .description('Check health of all active skills')
  .action(async () => {
    await registry.initialize();

    const activeSkills = registry.getActiveSkills();

    console.log('\n🏥 Skill Health Check\n');

    if (activeSkills.length === 0) {
      console.log('No active skills.\n');
      return;
    }

    for (const { id, instance } of activeSkills) {
      try {
        const health = await instance.healthCheck();
        const status = health.healthy ? '✅' : '❌';
        console.log(`${status} ${id}: ${health.status}`);
      } catch (err) {
        console.log(`❌ ${id}: Error - ${err.message}`);
      }
    }

    console.log();
  });

// Run CLI
program.parse();
