import { validMode, validUuid, type ProjectionMode } from './contract';

export type FlagEnv = Pick<Env, 'FLAGS' | 'ENVIRONMENT' | 'CANONICAL_KNOWLEDGE_FLAG' | 'CANONICAL_KNOWLEDGE_ENABLED'>;

type RecallFlagEnv = FlagEnv & {
  RECALL_RELIABILITY_FLAG?: string;
  RECALL_PARALLEL_RELIABILITY_ENABLED?: string;
};

type HyperPlannerFlagEnv = FlagEnv & { HYPER_FAST_PLANNER_FLAG?: string };

export async function evaluateHyperPlannerMode(
  env: HyperPlannerFlagEnv, orgId: string, userId: string,
): Promise<'off' | 'glm_no_reasoning'> {
  if (!validUuid(orgId) || !validUuid(userId)) return 'off';
  if (env.ENVIRONMENT !== 'local' && env.ENVIRONMENT !== 'production') return 'off';
  try {
    const details = await env.FLAGS.getStringDetails(
      env.HYPER_FAST_PLANNER_FLAG || 'hyperagents_fast_planner_v1', 'off',
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
    );
    const mode = details.value === 'glm_no_reasoning' ? 'glm_no_reasoning' : 'off';
    console.log(JSON.stringify({ event: 'hyper_planner_flag_evaluation', org_id: orgId, user_id: userId,
      mode, variant: details.variant, reason: details.reason, error_code: details.errorCode }));
    return mode;
  } catch (error) {
    console.error(JSON.stringify({ event: 'hyper_planner_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return 'off';
  }
}

export async function evaluateRecallReliability(env: RecallFlagEnv, orgId: string, userId: string): Promise<boolean> {
  if (String(env.RECALL_PARALLEL_RELIABILITY_ENABLED) !== 'true' || !validUuid(orgId) || !validUuid(userId)) return false;
  if (env.ENVIRONMENT !== 'local' && env.ENVIRONMENT !== 'production') return false;
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.RECALL_RELIABILITY_FLAG || 'recall_parallel_reliability_v1',
      false,
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
    );
    console.log(JSON.stringify({
      event: 'recall_reliability_flag_evaluation', org_id: orgId, user_id: userId,
      enabled: details.value === true, variant: details.variant, reason: details.reason, error_code: details.errorCode,
    }));
    return details.value === true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'recall_reliability_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

export async function evaluateProjectionMode(env: FlagEnv, orgId: string, userId: string): Promise<ProjectionMode | 'off'> {
  if (String(env.CANONICAL_KNOWLEDGE_ENABLED) !== 'true' || !validUuid(orgId) || !validUuid(userId)) return 'off';
  if (env.ENVIRONMENT !== 'local' && env.ENVIRONMENT !== 'production') return 'off';
  try {
    const details = await env.FLAGS.getStringDetails(
      env.CANONICAL_KNOWLEDGE_FLAG || 'canonical_knowledge_foundation_v1',
      'off',
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
    );
    const mode = validMode(details.value) ? details.value : 'off';
    console.log(JSON.stringify({
      event: 'canonical_projection_flag_evaluation', org_id: orgId, user_id: userId,
      mode, variant: details.variant, reason: details.reason, error_code: details.errorCode,
    }));
    return mode;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'canonical_projection_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return 'off';
  }
}
