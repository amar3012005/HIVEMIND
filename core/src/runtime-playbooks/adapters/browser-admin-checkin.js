import crypto from 'node:crypto';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function artifactId(context, key, suffix = '') {
  return `${key}-${crypto.createHash('sha256').update([context.runId, context.stageId, suffix].join('\u0000')).digest('hex').slice(0, 32)}`;
}

function sourceRefs(input) {
  const baseline = input.inputs?.['context.baseline'];
  return [baseline?.id || baseline?.resource_id].filter(Boolean).map(String);
}

export function createBrowserAdminCheckinAdapter() {
  return {
    id: 'browser-admin-checkin',
    name: 'Browser administrator check-in',
    description: 'Creates durable internal browser-check-in references without dialing or mutating lead records.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const action = String(input.config?.action || 'offer');
      const event = asObject(input.inputs?.event);
      if (action === 'offer') {
        return { artifacts: [{
          id: artifactId(context, 'admin-checkin-offer'), key: input.config?.output_key || 'admin_checkin_offer', status: 'READY',
          data: { run_id: context.runId, purpose: 'internal_company_status', channel: 'browser_voice' },
          source_refs: sourceRefs(input), external_ref: null,
        }] };
      }
      if (action === 'capture_choice') {
        const decision = event.type === 'admin_checkin.skipped' ? 'skipped' : 'started';
        return { artifacts: [{
          id: artifactId(context, 'admin-checkin-choice', event.id || decision), key: input.config?.output_key || 'admin_checkin_choice', status: 'READY',
          data: { decision, session_id: event.data?.session_id || null, correlation_ref: event.data?.session_id || null },
          source_refs: sourceRefs(input), external_ref: event.data?.session_id || null,
        }] };
      }
      if (action === 'observe') {
        const sessions = Array.isArray(input.inputs?.['artifacts.admin_checkin_choice']) ? input.inputs['artifacts.admin_checkin_choice'] : [];
        const session = sessions.at(-1)?.data?.session_id || null;
        return { artifacts: session ? [{
          id: artifactId(context, 'admin-checkin-session', session), key: input.config?.output_key || 'browser_session_subscription', status: 'READY',
          data: { correlation_ref: session, session_id: session }, source_refs: sourceRefs(input), external_ref: session,
        }] : [] };
      }
      throw new Error(`browser_admin_checkin_action_unknown:${action}`);
    },
  };
}
