import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const gateway = fs.readFileSync(new URL('../../src/llm/cloudflare-gateway.js', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../../src/vector/mneme/embedded-agent.mjs', import.meta.url), 'utf8');

test('meeting v2 suppresses Gateway payload logs and cache', () => {
  assert.match(gateway, /'cf-aig-collect-log-payload': 'false'/);
  assert.match(gateway, /'cf-aig-skip-cache': 'true'/);
});

test('durable meeting callback is service authenticated and never calls biometric identification', () => {
  const start = server.indexOf("if (pathname.startsWith('/internal/meeting-lifecycle/v2/'))");
  const end = server.indexOf('// ── Grok voice adapter', start);
  const lifecycle = server.slice(start, end);
  assert.match(lifecycle, /MEETING_LIFECYCLE_SECRET/);
  assert.match(lifecycle, /assertMeetingGatewayReady/);
  assert.doesNotMatch(lifecycle, /pyannoteIdentify|voiceprint|emotion/i);
});

test('tenant agent contains the v2 policy, receipt, checkpoint, restriction and deletion authorities', () => {
  for (const table of [
    'meeting_recording_policies', 'meeting_notice_versions', 'meeting_participants',
    'meeting_consent_requests', 'meeting_consent_receipts', 'meeting_consent_events',
    'meeting_authorization_snapshots', 'meeting_pipeline_steps', 'meeting_artifact_receipts',
    'meeting_processing_restrictions', 'meeting_data_subject_requests', 'meeting_deletion_receipts',
  ]) assert.match(agent, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test('legacy meeting path remains present behind an additive v2 admission check', () => {
  const admission = server.indexOf('createV2MeetingSession');
  assert.ok(admission >= 0);
  assert.match(server, /if \(body\?\.consent !== true\)/);
  assert.match(server, /orchestration_mode='legacy'/);
});

test('late participants pause capture and use the durable invitation outbox', () => {
  assert.match(server, /\(participants\|invitations\)/);
  const lifecycle = fs.readFileSync(new URL('../../src/knowledge/meeting-lifecycle-v2.js', import.meta.url), 'utf8');
  const start = lifecycle.indexOf('export async function addV2MeetingParticipants');
  const end = lifecycle.indexOf('export async function controlV2MeetingSession', start);
  const addition = lifecycle.slice(start, end);
  assert.match(addition, /status=CASE WHEN status='recording' THEN 'paused'/);
  assert.match(addition, /authorization_status='pending'/);
  assert.match(addition, /meeting\.authorization\.invitation/);
});

test('BYOD v2 fails closed until the tenant agent advertises lifecycle support', () => {
  assert.match(server, /remote_meeting_v2_agent_upgrade_required/);
  assert.match(server, /if \(!\['off', 'shadow'\]\.includes\(remoteV2Mode\)\)/);
});

test('email outbox cannot settle a provider rejection as completed', () => {
  const lifecycle = fs.readFileSync(new URL('../../src/knowledge/meeting-lifecycle-v2.js', import.meta.url), 'utf8');
  assert.match(lifecycle, /if \(!receipt\?\.ok\) throw new Error\(receipt\?\.error \|\| 'email_provider_rejected'\)/);
  const exchangeStart = lifecycle.indexOf('export async function exchangeMeetingInvitation');
  const exchangeEnd = lifecycle.indexOf('export async function verifyMeetingInvitation', exchangeStart);
  const exchange = lifecycle.slice(exchangeStart, exchangeEnd);
  assert.match(exchange, /meeting\.authorization\.otp/);
  assert.doesNotMatch(exchange, /sendSystemEmail\(/);
  assert.match(lifecycle, /payload=payload-'otp_ciphertext'/);
});
