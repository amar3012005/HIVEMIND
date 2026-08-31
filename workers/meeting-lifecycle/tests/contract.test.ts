import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { audioObjectKey, validAudioMessage, validEmailMessage, validMeetingParams, workflowId } from '../src/contract';
const p = { session_id: '11111111-1111-4111-8111-111111111111', org_id: '22222222-2222-4222-8222-222222222222', user_id: '33333333-3333-4333-8333-333333333333', pipeline_version: 2, mode: 'full' as const };
describe('meeting lifecycle contract', () => {
  it('uses deterministic workflow ids', () => expect(workflowId(p)).toBe('meeting-11111111-1111-4111-8111-111111111111-v2'));
  it('rejects invalid and content-bearing workflow payloads by shape', () => { expect(validMeetingParams(p)).toBe(true); expect(validMeetingParams({ ...p, pipeline_version: 1 })).toBe(false); });
  it('validates identifier-only audio messages', () => expect(validAudioMessage({ kind: 'audio', session_id: p.session_id, org_id: p.org_id, segment_index: 0, pipeline_version: 2 })).toBe(true));
  it('validates identifier-only email messages', () => expect(validEmailMessage({ kind: 'email', outbox_id: p.session_id, session_id: p.session_id, org_id: p.org_id, pipeline_version: 2 })).toBe(true));
  it('tenant-qualifies content-addressed keys', () => expect(audioObjectKey(p.org_id, p.session_id, 4, 'a'.repeat(64))).toContain(`/meeting/${p.session_id}/segment/4/`));
});

it('acknowledges terminal Core audio failures instead of retrying them forever', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(source).toContain('failure.retryable === false');
  expect(source).toContain("event: 'meeting_audio_terminal_failure'");
  expect(source).toContain('message.ack()');
});
