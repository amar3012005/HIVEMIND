import assert from 'node:assert/strict';
export const gates = ['nativeAuthentication', 'deviceMicrophone', 'oauthReturn', 'nativeStreaming', 'nativeFileSaving', 'accountDeletion', 'privacyReview', 'billingReview'];
export function validateReleaseEvidence(value, sha, platform) {
  assert.equal(value.format, 1, 'Unsupported evidence format.');
  assert.equal(value.frontendSha, sha, 'Evidence must match the packaged frontend.');
  assert.equal(value.platform, platform, 'Evidence must cover this native platform.');
  assert.ok(typeof value.device === 'string' && value.device.trim(), 'Record the tested physical device and OS.');
  assert.ok(typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt)), 'Record the verification date.');
  for (const field of gates) {
    assert.equal(value[field]?.verified, true, `Live verification missing: ${field}`);
    assert.ok(typeof value[field]?.evidence === 'string' && value[field].evidence.trim(), `Evidence missing: ${field}`);
  }
}
