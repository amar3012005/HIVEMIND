export type IngestParams = {
  job_id: string;
  org_id: string;
  user_id: string;
  processing_version: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validParams(value: unknown): value is IngestParams {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return UUID.test(String(input.job_id || ''))
    && UUID.test(String(input.org_id || ''))
    && UUID.test(String(input.user_id || ''))
    && Number.isInteger(Number(input.processing_version))
    && Number(input.processing_version) > 0;
}

export function workflowInstanceId(params: IngestParams): string {
  return `kb-${params.job_id}-v${params.processing_version}`;
}

export function validOrgId(value: string): boolean {
  return UUID.test(value);
}
