export type MeetingParams = { session_id: string; org_id: string; user_id: string; pipeline_version: number; mode: 'workflow' | 'full'; instance_id?: string };
export type AudioMessage = { kind: 'audio'; session_id: string; org_id: string; segment_index: number; pipeline_version: number };
export type EmailMessage = { kind: 'email'; outbox_id: string; session_id: string; org_id: string; pipeline_version: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validUuid = (value: unknown) => UUID.test(String(value || ''));
export function validMeetingParams(value: unknown): value is MeetingParams {
  const v = value as Record<string, unknown>;
  return !!v && validUuid(v.session_id) && validUuid(v.org_id) && validUuid(v.user_id)
    && Number(v.pipeline_version) === 2 && (v.mode === 'workflow' || v.mode === 'full');
}
export function validAudioMessage(value: unknown): value is AudioMessage {
  const v = value as Record<string, unknown>;
  return !!v && v.kind === 'audio' && validUuid(v.session_id) && validUuid(v.org_id) && Number.isInteger(Number(v.segment_index)) && Number(v.segment_index) >= 0 && Number(v.pipeline_version) === 2;
}
export function validEmailMessage(value: unknown): value is EmailMessage {
  const v = value as Record<string, unknown>;
  return !!v && v.kind === 'email' && validUuid(v.outbox_id) && validUuid(v.session_id) && validUuid(v.org_id) && Number(v.pipeline_version) === 2;
}
export const workflowId = (p: MeetingParams) => `meeting-${p.session_id}-v${p.pipeline_version}`;
export const audioObjectKey = (orgId: string, sessionId: string, index: number, checksum: string) => `org/${orgId}/meeting/${sessionId}/segment/${index}/${checksum}.webm`;
