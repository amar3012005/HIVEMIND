/** Run inside the existing control service with its existing DB/webhook auth; no subscription mutation. */
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const coreRoot = process.env.HIVEMIND_CANARY_CORE_ROOT || resolve(import.meta.dirname, '..');
const require = createRequire(resolve(coreRoot, 'package.json'));
const Ajv = require('ajv'), addFormats = require('ajv-formats');
const { getPrismaClient } = await import(pathToFileURL(resolve(coreRoot, 'src/db/prisma.js')).href);
const [orgId, userId, subscriptionId, fixturePath, expected] = process.argv.slice(2);
if (![orgId, userId, subscriptionId].every(v => /^[0-9a-f-]{36}$/i.test(v || ''))
  || !fixturePath || !['observe', 'retain', 'notify', 'wake'].includes(expected)) throw Error('scoped_canary_arguments_required');
const db = getPrismaClient();
try {
  const rows = await db.$queryRawUnsafe(`SELECT * FROM hivemind_trigger_subscriptions
    WHERE id=$1::uuid AND org_id=$2 AND user_id=$3 AND status='active' AND runtime_attention=true`, subscriptionId, orgId, userId);
  if (rows.length !== 1) throw Error('explicit_active_opt_in_required');
  const row = rows[0], data = JSON.parse(await readFile(fixturePath, 'utf8'));
  const validator = new Ajv({ strict: false }); addFormats(validator);
  if (!validator.compile(row.payload_schema)(data)) throw Error('fixture_does_not_match_existing_subscription_schema');
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) throw Error('existing_webhook_signing_configuration_required');
  const id = `runtime-attention-canary-${randomUUID()}`;
  const payload = { id, type: 'composio.trigger.message', metadata: {
    trigger_id: row.remote_id, connected_account_id: row.account_id, trigger_slug: row.slug, user_id: row.subject,
  }, data };
  const raw = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${id}.${timestamp}.${raw}`).digest('base64');
  const endpoint = 'http://127.0.0.1:3000/v1/hivemind/triggers/webhook';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, body: raw });
    if (!response.ok) throw Error(`existing_receiver_rejected_${response.status}`);
  }
  const eventId = `${id}:${row.id}`;
  let receipt;
  for (let attempt = 0; attempt < 20; attempt++) {
    const events = await db.$queryRawUnsafe(`SELECT relevance_status,relevance_decision FROM hivemind_trigger_events
      WHERE id=$1 AND org_id=$2 AND user_id=$3`, eventId, orgId, userId);
    if (events.length !== 1) throw Error('event_not_exactly_once');
    receipt = events[0];
    if (receipt.relevance_status !== 'pending' && receipt.relevance_status !== 'evaluating') break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const decision = receipt?.relevance_decision;
  const action = decision?.runtimeAttention?.action ?? (receipt?.relevance_status === 'rejected' ? 'retain' : undefined);
  console.log(JSON.stringify({ eventId, status: receipt?.relevance_status, action,
    delivered: decision?.runtimeDelivery?.status === 'accepted', expected, matchedExpectation: expected === 'observe' ? null : action === expected,
    duplicateSubmissions: 2, storedEvents: 1 }));
  // A valid Jev retain/notify decision is not a transport failure. Expectations are optional and never override it.
  if (!['approved', 'rejected'].includes(receipt?.relevance_status)
    || (action === 'wake' && decision?.runtimeDelivery?.status !== 'accepted')) process.exitCode = 1;
} finally { await db.$disconnect(); }
