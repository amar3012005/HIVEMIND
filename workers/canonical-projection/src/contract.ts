export const PROJECTION_MODES = ['shadow', 'write', 'read', 'full'] as const;
export type ProjectionMode = typeof PROJECTION_MODES[number];

export type ProjectionParams = {
  memory_id: string;
  org_id: string;
  processing_version: number;
  required_projection: ProjectionMode;
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

export function workflowInstanceId(params: ProjectionParams): string {
  return `claim-${params.memory_id}-v${params.processing_version}`;
}
