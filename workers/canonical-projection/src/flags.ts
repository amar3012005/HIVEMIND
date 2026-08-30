import { validMode, validUuid, type ProjectionMode } from './contract';

export type FlagEnv = Pick<Env, 'FLAGS' | 'ENVIRONMENT' | 'CANONICAL_KNOWLEDGE_FLAG' | 'CANONICAL_KNOWLEDGE_ENABLED'>;

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
