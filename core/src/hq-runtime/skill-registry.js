import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGrowthBaseline } from '../growth/baseline.js';
import { runGrowthPlan } from '../growth/planner.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const roots = [
  process.env.HQ_RUNTIME_ASSET_DIR,
  path.resolve(process.cwd(), 'hq-runtime'),
  path.resolve(moduleDir, '../../../employees-service/src/HQ-runtime'),
].filter(Boolean);

function assetPath(...parts) {
  const root = roots.find((candidate) => fs.existsSync(candidate));
  if (!root) throw new Error('hq_runtime_assets_unavailable');
  return path.join(root, ...parts);
}

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(assetPath(...parts), 'utf8'));
}

export class HqSkillRegistry {
  constructor() {
    const registry = readJson('skills', 'registry.json');
    this.version = registry.version;
    this.skills = new Map(registry.skills.map((skill) => [skill.id, skill]));
  }

  descriptors() {
    return [...this.skills.values()].map(({ id, description }) => ({ id, description }));
  }

  load(id) {
    const descriptor = this.skills.get(id);
    if (!descriptor) throw new Error(`hq_skill_unknown:${id}`);
    return { ...descriptor, body: fs.readFileSync(assetPath('skills', `${id}.md`), 'utf8') };
  }

  directorInstructions() {
    return fs.readFileSync(assetPath('instructions', 'director.md'), 'utf8');
  }
}

export class HqToolkitRegistry {
  constructor() {
    const registry = readJson('toolkits', 'registry.json');
    this.version = registry.version;
    this.toolkits = new Map(registry.toolkits.map((toolkit) => [toolkit.id, toolkit]));
  }

  descriptors() {
    return [...this.toolkits.values()];
  }

  select(ids = []) {
    return [...new Set(ids)].map((id) => {
      const descriptor = this.toolkits.get(id);
      if (!descriptor) throw new Error(`hq_toolkit_unknown:${id}`);
      return descriptor;
    });
  }

  async invoke(id, operation, args, context) {
    this.select([id]);
    if (id === 'growth_baseline' && operation === 'collect') {
      return runGrowthBaseline({ ...context, ...args });
    }
    if (id === 'growth_plan' && operation === 'run') {
      return runGrowthPlan({ ...context, ...args });
    }
    throw new Error(`hq_toolkit_operation_unknown:${id}:${operation}`);
  }
}
