export const PROJECTION_MODES = ['shadow', 'write', 'read', 'full'] as const;
export type ProjectionMode = typeof PROJECTION_MODES[number];

export const CORE_STAGE_NAMES = [
  'load', 'reconstruct', 'resolve', 'normalize', 'persist', 'reconcile', 'complete', 'failed',
] as const;
export type CoreStageName = typeof CORE_STAGE_NAMES[number];

export type ProjectionParams = {
  memory_id: string;
  org_id: string;
  processing_version: number;
  required_projection: ProjectionMode;
};

export const ENTITY_PROFILE_MODES = ['shadow', 'dynamic_auto', 'review_only'] as const;
export type EntityProfileMode = typeof ENTITY_PROFILE_MODES[number];
export type EntityProfileParams = {
  entity_id: string;
  org_id: string;
  source_watermark: string;
  required_projection: EntityProfileMode;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function validMode(value: unknown): value is ProjectionMode {
  return typeof value === 'string' && PROJECTION_MODES.includes(value as ProjectionMode);
}

export function validParams(value: unknown): value is ProjectionParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 4
    && validUuid(input.memory_id)
    && validUuid(input.org_id)
    && Number.isInteger(input.processing_version)
    && Number(input.processing_version) > 0
    && validMode(input.required_projection);
}

export function validEntityProfileParams(value: unknown): value is EntityProfileParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 4
    && validUuid(input.entity_id)
    && validUuid(input.org_id)
    && typeof input.source_watermark === 'string' && input.source_watermark.length > 0 && input.source_watermark.length <= 128
    && ENTITY_PROFILE_MODES.includes(input.required_projection as EntityProfileMode);
}

export function workflowInstanceId(params: ProjectionParams): string {
  return `claim-${params.memory_id}-v${params.processing_version}`;
}

export function entityProfileWorkflowInstanceId(params: EntityProfileParams): string {
  return `entity-profile-${params.entity_id}-${params.source_watermark.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`;
}

export function coreStagePath(memoryId: string, stage: CoreStageName): string {
  if (!validUuid(memoryId)) throw new Error('invalid_memory_id');
  return `/internal/canonical-projection/v1/memories/${memoryId}/stages/${stage}`;
}
