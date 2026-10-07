/** Explicit TEST-ONLY transport proof. Does not assert or replace a genuine Jev classification. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [orgId, userId, subscriptionId, authorization] = process.argv.slice(2);
if (![orgId, userId, subscriptionId].every(v => /^[0-9a-f-]{36}$/i.test(v || ''))
  || authorization !== '--authorize-test-only-native-admission') throw Error('explicit_scoped_transport_test_authorization_required');
const root = process.env.HIVEMIND_CANARY_CORE_ROOT || resolve(import.meta.dirname, '..');
const { getPrismaClient } = await import(pathToFileURL(resolve(root, 'src/db/prisma.js')).href);
const { runtimeAttentionToken } = await import(pathToFileURL(resolve(root, 'src/connectors/composio/runtime-attention-bridge.js')).href);
const db = getPrismaClient(), eventId = `runtime-attention-transport-only-${randomUUID()}:${subscriptionId}`;
const row = { id: eventId, org_id: orgId, user_id: userId };
async function call(operation) {
  const response = await fetch(process.env.HIVEMIND_RUNTIME_ATTENTION_URL, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${runtimeAttentionToken(row, operation, process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET)}`,
  }, body: JSON.stringify({ operation, eventId, orgId, userId }) });
  return { httpStatus: response.status, receipt: await response.json() };
}
try {
  const allowed = await db.$queryRawUnsafe(`SELECT id FROM hivemind.hivemind_trigger_subscriptions
    WHERE id=$1::uuid AND org_id=$2 AND user_id=$3 AND status='active' AND runtime_attention=true`, subscriptionId, orgId, userId);
  if (allowed.length !== 1) throw Error('existing_explicit_owner_opt_in_required');
  const data = { subject: 'SYNTHETIC TEST ONLY — native admission transport canary',
    message_text: 'Synthetic transport validation only. Not a real email, customer message, business finding, or company objective. No external action or new tasks requested. Preserve accepted tasks, existing handoff and next wake. Acknowledge the test receipt only if needed and return to the previous sleep state.' };
  const base = { policy: 'company_activity_relevance_v2', source: 'live_transport_canary', status: 'approved', testOnly: true };
  await db.$executeRawUnsafe(`INSERT INTO hivemind.hivemind_trigger_events
    (id,subscription_id,org_id,user_id,data,relevance_status,relevance_decision,evaluated_at)
    VALUES($1,$2::uuid,$3,$4,$5::jsonb,'approved',$6::jsonb,now())`, eventId, subscriptionId, orgId, userId, JSON.stringify(data), JSON.stringify(base));
  const before = await call('context');
  if (before.httpStatus !== 200 || before.receipt.snapshot?.enabled !== true) throw Error('current_native_context_required');
  const snapshot = before.receipt.snapshot;
  const testDecision = { ...base, runtimeAttention: { policy: 'runtime_attention_v2', source: 'live_transport_canary', action: 'wake',
    contextRevision: snapshot.revision, targetSessionId: snapshot.sessionId, probability: 1, margin: 1 } };
  // Only the new, explicitly labeled test event is changed. Genuine Jev receipts remain untouched.
  await db.$executeRawUnsafe('UPDATE hivemind.hivemind_trigger_events SET relevance_decision=$1::jsonb WHERE id=$2 AND org_id=$3 AND user_id=$4',
    JSON.stringify(testDecision), eventId, orgId, userId);
  const first = await call('deliver'), second = await call('deliver');
  const count = await db.$queryRawUnsafe(`SELECT count(*)::int AS admissions FROM hivemind.harness_session_events e
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.payload->'data'->'inserted','[]'::jsonb)) message
    WHERE e.session_id=$1 AND e.org_id=$2::uuid AND e.user_id=$3::uuid AND e.event_type='agent/inbox/spliced'
    AND message->'source'->>'kind'='hivemind-runtime-event' AND message->'source'->>'eventId'=$4`, snapshot.sessionId, orgId, userId, eventId);
  console.log(JSON.stringify({ eventId, testOnly: true, classificationSource: 'live_transport_canary', first, second,
    durableAdmissions: count[0]?.admissions, targetSessionId: snapshot.sessionId }));
  if (first.httpStatus !== 202 || second.httpStatus !== 200 || second.receipt.reused !== true
    || first.receipt.targetSessionId !== snapshot.sessionId || second.receipt.targetSessionId !== snapshot.sessionId
    || count[0]?.admissions !== 1) process.exitCode = 1;
  // Admission is not completed work. Inspect the ensuing native turn/rest receipts separately.
} finally { await db.$disconnect(); }
