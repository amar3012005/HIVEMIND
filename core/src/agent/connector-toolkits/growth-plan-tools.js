import { getLatestGrowthPlan, listGrowthPlans, runGrowthPlan } from '../../growth/planner.js';

const GROUP = 'growth_plan';
const ASPECTS = ['positioning', 'audience', 'offer', 'product_readiness', 'channels', 'content', 'pipeline', 'measurement', 'operations', 'risks'];

const definitions = [
  { name: 'growth_plan_run', readOnly: false, description: 'Run the independent Company Growth Planner. Use initial_full once after a full baseline to assess the whole growth system. Use operate afterward with only the aspects required by the current decision. Creates one bounded Growth Stage and one tenant-scoped specialist Work Order without running the generic Room debate pipeline.', parameters: { type: 'object', additionalProperties: false, properties: {
    mode: { type: 'string', enum: ['initial_full', 'operate'] }, aspects: { type: 'array', items: { type: 'string', enum: ASPECTS } },
    objective: { type: 'string' }, autonomy_mode: { type: 'string', enum: ['MANUAL_REVIEW', 'ASSISTED', 'AUTO'] }, first_life_policy_version: { type: 'integer', minimum: 1 },
  }, required: ['mode'] } },
  { name: 'growth_plan_latest', readOnly: true, description: 'Read the latest persisted Growth Operating Plan, its aspect assessments, current stage, and delegation.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'growth_plan_history', readOnly: true, description: 'List prior Growth Operating Plans so HQ can compare decisions and continue the operating loop without replaying Room history.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } },
];

export function getGrowthPlanToolCatalog() { return { name: GROUP, description: 'Independent tenant-scoped growth planning and operating-loop decisions.', tools: definitions }; }

export function registerGrowthPlanTools(toolkit, { prisma, orgId, userId, selectedGroups = [] }) {
  const selected = new Set(selectedGroups);
  toolkit.createToolGroup({ name: GROUP, description: 'Independent Growth Operating Planner.', active: selected.has(GROUP), notes: 'Use initial_full after the first complete baseline. Use operate with selected aspects for subsequent checkpoints. This tool commits a stage and Work Order.' });
  for (const def of definitions) toolkit.registerToolFunction({ ...def, groupName: GROUP, handler: async (args, ctx) => {
    if (def.name === 'growth_plan_latest') { const artifact = await getLatestGrowthPlan({ prisma, orgId }); return artifact ? { available: true, resource_id: artifact.id, captured_at: artifact.createdAt, ...artifact.payload } : { available: false }; }
    if (def.name === 'growth_plan_history') return { plans: await listGrowthPlans({ prisma, orgId, limit: args?.limit }) };
    return runGrowthPlan({ prisma, orgId, userId, mode: args.mode, aspects: args.aspects, objective: args.objective, autonomyMode: args.autonomy_mode, turnId: ctx?.turnId || ctx?.turn_id, firstLifePolicyVersion: args.first_life_policy_version });
  } });
}
