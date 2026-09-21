import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { readWorkRunArtifact } from '../../src/routes/workrun-artifacts.js';

const ids = {
  user: '11111111-1111-1111-1111-111111111111',
  org: '22222222-2222-2222-2222-222222222222',
  run: '33333333-3333-3333-3333-333333333333',
  artifact: '44444444-4444-4444-4444-444444444444',
};

function prismaFor(artifact, artifactIds = [ids.artifact]) {
  return {
    $queryRawUnsafe: async () => [{ id: ids.run, result_artifact_ids: artifactIds }],
    sourceArtifact: { findFirst: async () => artifact },
  };
}

test('reads a WorkRun artifact from the admitted durable object and verifies its checksum', async () => {
  const bytes = Buffer.from('# durable brief');
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const objectKey = `org/${ids.org}/sha256/${checksum}/brief.md`;
  const result = await readWorkRunArtifact({
    prisma: prismaFor({ checksum, storageLocation: `r2:${objectKey}`, contentType: 'text/markdown', payload: { object_key: objectKey, etag: 'etag-1', path: 'reports/brief.md' } }),
    workRunId: ids.run, artifactId: ids.artifact, userId: ids.user, orgId: ids.org,
    artifactStorage: { configured: () => true, getObject: async (key, { expectedEtag }) => { assert.equal(key, objectKey); assert.equal(expectedEtag, 'etag-1'); return bytes; } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.bytes.toString(), '# durable brief');
  assert.equal(result.filename, 'brief.md');
});

test('refuses artifact reads that are not listed on the authenticated WorkRun', async () => {
  const result = await readWorkRunArtifact({
    prisma: prismaFor({}, []), workRunId: ids.run, artifactId: ids.artifact, userId: ids.user, orgId: ids.org,
  });
  assert.equal(result.status, 404);
  assert.equal(result.code, 'WORKRUN_ARTIFACT_NOT_FOUND');
});

test('refuses durable bytes whose checksum differs from the receipt', async () => {
  const expected = crypto.createHash('sha256').update('expected').digest('hex');
  const objectKey = `org/${ids.org}/sha256/${expected}/brief.md`;
  const result = await readWorkRunArtifact({
    prisma: prismaFor({ checksum: expected, storageLocation: `r2:${objectKey}`, payload: { object_key: objectKey } }),
    workRunId: ids.run, artifactId: ids.artifact, userId: ids.user, orgId: ids.org,
    artifactStorage: { configured: () => true, getObject: async () => Buffer.from('different') },
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ARTIFACT_INTEGRITY_FAILED');
});

test('continues to read legacy inline artifacts with the same receipt check', async () => {
  const bytes = Buffer.from('legacy');
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = await readWorkRunArtifact({
    prisma: prismaFor({ checksum, storageLocation: 'inline:source_artifacts.payload', contentType: 'text/plain', payload: { content_base64: bytes.toString('base64'), path: 'legacy.txt' } }),
    workRunId: ids.run, artifactId: ids.artifact, userId: ids.user, orgId: ids.org,
  });
  assert.equal(result.status, 200);
  assert.equal(result.bytes.toString(), 'legacy');
});
