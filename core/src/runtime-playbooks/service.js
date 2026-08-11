import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { RuntimePlaybookRegistry, createJsonPlaybookSource, createPrismaPlaybookSource } from './registry.js';
import { PredicateEngine } from './predicate-engine.js';
import { PostgresRuntimeStore } from './postgres-store.js';
import { GenericStageExecutor } from './stage-executor.js';
import { DirectorPlaybookSelector } from './director-selector.js';
import { RuntimeRoomDirector } from './room-director.js';
import { createProductionRuntimeAdapterRegistry } from './adapters/index.js';

const fixtureDirectory = new URL('./fixtures/', import.meta.url);
const executionPolicyUrl = new URL('./fixtures/runtime-execution-policy.v2.json', import.meta.url);

async function productionFixturePaths() {
  const manifest = JSON.parse(await readFile(new URL('registry.json', fixtureDirectory), 'utf8'));
  if (!Array.isArray(manifest) || manifest.some((entry) => typeof entry !== 'string' || !entry.endsWith('.json'))) {
    throw new Error('runtime_playbook_fixture_manifest_invalid');
  }
  return manifest.map((entry) => fileURLToPath(new URL(entry, fixtureDirectory)));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(left, right) {
  const merged = { ...asObject(left) };
  for (const [key, value] of Object.entries(asObject(right))) {
    merged[key] = isObject(value) && isObject(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

export class RuntimePlaybookService {
  constructor({ prisma, registry, selector, executor, logger = console, onRunState = null } = {}) {
    this.prisma = prisma;
    this.registry = registry;
    this.selector = selector;
    this.executor = executor;
    this.logger = logger;
    this.onRunState = onRunState;
  }

  static async create({ prisma, logger = console, director = null, adapters = null, completionFetch = undefined, onRunState = null, onStageState = null } = {}) {
    if (!prisma) throw new Error('runtime_playbook_service_prisma_required');
    const registry = new RuntimePlaybookRegistry();
    await registry.load([createJsonPlaybookSource(await productionFixturePaths())]);
    try {
      await registry.load([createPrismaPlaybookSource({ prisma })]);
    } catch (error) {
      logger.warn?.('[runtime-playbooks] persisted registry unavailable:', error.message);
    }
    const nonterminalRuns = await prisma.runtimePlaybookRun.findMany({
      where: { status: { notIn: ['COMPLETED', 'TERMINATED'] } },
      select: { id: true, scopeKey: true, playbookId: true, playbookVersion: true, status: true },
      take: 10000,
    });
    const unresolved = [];
    for (const run of nonterminalRuns) {
      try {
        registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
      } catch {
        unresolved.push(`${run.id}:${run.scopeKey}:${run.playbookId}:v${run.playbookVersion}:${run.status}`);
      }
    }
    if (unresolved.length) {
      throw new Error(`runtime_playbook_nonterminal_definitions_missing:${unresolved.join(',')}`);
    }
    const selector = new DirectorPlaybookSelector({ registry, ...(completionFetch ? { completionFetch } : {}) });
    let serviceRef = null;
    const adapterRegistry = adapters || createProductionRuntimeAdapterRegistry({ prisma, getService: () => serviceRef });
    const executionPolicy = JSON.parse(await readFile(executionPolicyUrl, 'utf8'));
    const executor = new GenericStageExecutor({
      registry,
      predicates: new PredicateEngine(),
      store: new PostgresRuntimeStore({ prisma }),
      director: director || new RuntimeRoomDirector({ prisma }),
      selector,
      adapters: adapterRegistry,
      onStageState,
      executionPolicy,
    });
    serviceRef = new RuntimePlaybookService({ prisma, registry, selector, executor, logger, onRunState });
    return serviceRef;
  }

  async tryCreateAssignment({ orgId, roomId, objective, idempotencyKey, trigger = {}, context = {}, scopeKey = 'global' } = {}) {
    const selected = await this.selectAssignment({ objective, context, scopeKey });
    if (!selected.matched) return selected;
    return this.createSelectedAssignment({
      orgId, roomId, objective, idempotencyKey, trigger, context, scopeKey,
      selection: selected.selection,
    });
  }

  async selectAssignment({ objective, context = {}, scopeKey = 'global' } = {}) {
    const selection = await this.selector.select({ objective, context, scopeKey });
    if (!selection.playbook_id) return { matched: false, selection };
    const playbook = this.registry.get(selection.playbook_id, selection.version, { scopeKey });
    if (!String(playbook.metadata?.owner_room_tag || '').trim()) {
      throw new Error(`runtime_playbook_owner_room_required:${selection.playbook_id}:${selection.version}`);
    }
    return { matched: true, selection, playbook };
  }

  async createSelectedAssignment({ orgId, roomId, idempotencyKey, trigger = {}, context = {}, scopeKey = 'global', selection, parentRunId = null, parentStageId = null, itemKey = null, position = null } = {}) {
    if (!selection?.playbook_id || !selection?.version) throw new Error('runtime_playbook_selection_required');
    const run = await this.executor.createRun({
      orgId,
      roomId,
      scopeKey,
      playbookId: selection.playbook_id,
      playbookVersion: selection.version,
      idempotencyKey,
      parentRunId,
      parentStageId,
      itemKey,
      position,
      trigger: asObject(trigger),
      context: { ...deepMerge(context, selection.context_patch), playbook_selection: selection },
    });
    return { matched: true, selection, run, playbook: this.registry.get(selection.playbook_id, selection.version, { scopeKey }) };
  }

  async execute(runId, orgId, options = {}) {
    const before = await this.prisma.runtimePlaybookRun.findFirst({ where: { id: runId, orgId }, select: { status: true } });
    const run = await this.executor.run(runId, { orgId, ...options });
    if (this.onRunState && run?.status && run.status !== before?.status) {
      await this.onRunState({ run, previousStatus: before?.status || null });
    }
    if (run?.parentRunId && ['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION'].includes(String(run.status))) {
      const artifactRefs = (run.artifacts || []).map((artifact) => artifact.id || artifact.artifactId).filter(Boolean);
      await this.execute(run.parentRunId, orgId, {
        event: {
          id: `child:${run.id}:${run.version}:${run.status}`,
          type: 'child.terminal',
          data: {
            child_run_id: run.id,
            item_key: run.itemKey,
            status: run.status,
            terminal_state: run.terminalState || null,
            artifact_refs: artifactRefs,
          },
        },
      });
    }
    return run;
  }

  async grantAuthority(runId, orgId, gate, grant = {}) {
    const authority = await this.executor.grantAuthority(runId, orgId, gate, grant);
    const run = await this.execute(runId, orgId);
    return { authority, run };
  }

  async resumeEvent(runId, orgId, event) {
    return this.execute(runId, orgId, { event });
  }

  async resumeIntervention(runId, orgId, input = {}) {
    await this.executor.resumeIntervention(runId, orgId, input);
    return this.execute(runId, orgId);
  }

  async drainActive({ limit = 4 } = {}) {
    const rows = await this.prisma.runtimePlaybookRun.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'asc' },
      take: Math.max(1, Math.min(20, Number(limit) || 4)),
      select: { id: true, orgId: true },
    });
    return Promise.all(rows.map(async (row) => {
      try {
        return await this.execute(row.id, row.orgId);
      } catch (error) {
        this.logger.error?.('[runtime-playbooks] run failed:', row.id, error.message);
        return { id: row.id, orgId: row.orgId, status: 'FAILED', error: error.message };
      }
    }));
  }

  async monitorDeadlines() {
    return this.executor.monitorDeadlines();
  }
}

export async function createProductionRuntimePlaybookService(options) {
  return RuntimePlaybookService.create(options);
}
