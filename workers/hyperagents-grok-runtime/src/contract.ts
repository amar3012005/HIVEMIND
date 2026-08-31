export const MODES = [
  'off', 'shadow_roster', 'persistent_agents', 'durable_assignments',
  'real_tools', 'collaboration', 'browser', 'skills', 'routines', 'full',
] as const;
export type RuntimeMode = typeof MODES[number];
export type TurnParams = {
  turn_id: string;
  room_id: string;
  org_id: string;
  user_id: string;
  mode: RuntimeMode;
  processing_version: number;
};
export type AssignmentParams = TurnParams & {
  work_order_id: string;
  agent_instance_id: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const normalizeMode = (value: unknown): RuntimeMode => MODES.includes(value as RuntimeMode) ? value as RuntimeMode : 'off';
export const modeRank = (value: unknown): number => MODES.indexOf(normalizeMode(value));
export const workflowId = (turnId: string, version: number): string => `room-${turnId}-v${Math.max(1, Number(version) || 1)}`;
export const assignmentWorkflowId = (workOrderId: string, version: number): string => `agent-${workOrderId}-v${Math.max(1, Number(version) || 1)}`;
export function validParams(value: unknown): value is TurnParams {
  const p = value as Partial<TurnParams>;
  return !!p && UUID.test(String(p.turn_id || '')) && UUID.test(String(p.room_id || ''))
    && UUID.test(String(p.org_id || '')) && UUID.test(String(p.user_id || ''))
    && normalizeMode(p.mode) === p.mode && p.mode !== 'off'
    && Number.isInteger(p.processing_version) && Number(p.processing_version) > 0;
}
export function validAssignmentParams(value: unknown): value is AssignmentParams {
  const assignment = value as Partial<AssignmentParams>;
  return validParams(value) && UUID.test(String(assignment.work_order_id || ''))
    && /^ha-[a-f0-9]{32}-v[1-9][0-9]*$/i.test(String(assignment.agent_instance_id || ''));
}
