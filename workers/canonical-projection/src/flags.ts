import { validMode, validUuid, type ProjectionMode } from './contract';

export type FlagEnv = Pick<Env, 'FLAGS' | 'ENVIRONMENT' | 'CANONICAL_KNOWLEDGE_FLAG' | 'CANONICAL_KNOWLEDGE_ENABLED'>;

type RecallFlagEnv = FlagEnv & {
  RECALL_RELIABILITY_FLAG?: string;
  RECALL_PARALLEL_RELIABILITY_ENABLED?: string;
};

type HyperPlannerFlagEnv = FlagEnv & { HYPER_FAST_PLANNER_FLAG?: string };
type GovernedRoomFlagEnv = FlagEnv & { HYPER_GOVERNED_ROOM_FLAG?: string };
type OperatingRoomFlagEnv = FlagEnv & { OPERATING_ROOM_FLAG?: string };
type EntityDiscoveryFlagEnv = FlagEnv & { ENTITY_DISCOVERY_FLAG?: string };
type TaraGrokFlagEnv = FlagEnv & { TARA_GROK_FLAG?: string };

export async function evaluateGovernedRoomCanary(
  env: GovernedRoomFlagEnv, orgId: string, userId: string, email: string,
): Promise<boolean> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!validUuid(orgId) || !validUuid(userId) || !normalizedEmail) return false;
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return false;
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.HYPER_GOVERNED_ROOM_FLAG || 'hyperagents_governed_room_v1', false,
      {
        targetingKey: `${orgId}:${userId}`,
        org_id: orgId,
        user_id: userId,
        email: normalizedEmail,
        environment: env.ENVIRONMENT,
      },
    );
    return details.value === true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'governed_room_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

// Live voice rooms are a separate rollout from governed text-room turns.  A
// shared flag would let a text-only canary accidentally provision media.
export async function evaluateOperatingRoomCanary(
  env: OperatingRoomFlagEnv, orgId: string, userId: string, email: string,
): Promise<boolean> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!validUuid(orgId) || !validUuid(userId) || !normalizedEmail) return false;
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return false;
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.OPERATING_ROOM_FLAG || 'operating_rooms_v1', false,
      {
        targetingKey: `${orgId}:${userId}`,
        org_id: orgId,
        user_id: userId,
        email: normalizedEmail,
        environment: env.ENVIRONMENT,
      },
    );
    return details.value === true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'operating_room_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

export async function evaluateEntityDiscoveryCanary(
  env: EntityDiscoveryFlagEnv, orgId: string, userId: string, email: string,
): Promise<boolean> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!validUuid(orgId) || !validUuid(userId) || !normalizedEmail) return false;
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return false;
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.ENTITY_DISCOVERY_FLAG || 'entity_discovery_v1', false,
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, email: normalizedEmail, environment: env.ENVIRONMENT },
    );
    return details.value === true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'entity_discovery_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

// Grok realtime voice is separately admitted from operating rooms and text
// features.  This keeps a provider-key or adapter deployment from exposing a
// browser voice surface before the intended tenant/user canary is enabled.
export async function evaluateTaraGrokCanary(
  env: TaraGrokFlagEnv, orgId: string, userId: string, email: string,
): Promise<boolean> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!validUuid(orgId) || !validUuid(userId) || !normalizedEmail) return false;
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return false;
  try {
    const details = await env.FLAGS.getBooleanDetails(
      env.TARA_GROK_FLAG || 'tara_grok_voice_v1', false,
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, email: normalizedEmail, environment: env.ENVIRONMENT },
    );
    return details.value === true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'tara_grok_flag_error', org_id: orgId, user_id: userId,
      message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

export async function evaluateHyperPlannerMode(
  env: HyperPlannerFlagEnv, orgId: string, userId: string,
): Promise<'off' | 'glm_no_reasoning'> {
  if (!validUuid(orgId) || !validUuid(userId)) return 'off';
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return 'off';
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
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return false;
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
  if (!['local', 'enigma', 'production'].includes(env.ENVIRONMENT)) return 'off';
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
