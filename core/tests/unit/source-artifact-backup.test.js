import test from 'node:test';
import assert from 'node:assert/strict';

import { SourceArtifactBackup } from '../../src/knowledge/source-artifact-backup.js';

test('object storage writes immutable artifact bytes using the configured S3-compatible endpoint', async () => {
  const original = {
    bucket: process.env.SOURCE_ARTIFACT_BUCKET,
    endpoint: process.env.SOURCE_ARTIFACT_ENDPOINT,
    accessKey: process.env.SOURCE_ARTIFACT_ACCESS_KEY,
    secretKey: process.env.SOURCE_ARTIFACT_SECRET_KEY,
  };
  const originalFetch = globalThis.fetch;
  process.env.SOURCE_ARTIFACT_BUCKET = 'hive-artifacts';
  process.env.SOURCE_ARTIFACT_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
  process.env.SOURCE_ARTIFACT_ACCESS_KEY = 'access-key';
  process.env.SOURCE_ARTIFACT_SECRET_KEY = 'secret-key';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };

  try {
    const store = new SourceArtifactBackup({ logger: { info() {}, warn() {} } });
    const stored = await store.store({
      key: 'org/org-1/workruns/run-1/artifacts/artifact-1/abc',
      contentType: 'text/plain',
      bytes: Buffer.from('durable report'),
    });

    assert.equal(stored.stored, true);
    assert.equal(stored.key, 'org/org-1/workruns/run-1/artifacts/artifact-1/abc');
    assert.equal(stored.byteCount, Buffer.byteLength('durable report'));
    assert.equal(request.url, 'https://account.r2.cloudflarestorage.com/hive-artifacts/org/org-1/workruns/run-1/artifacts/artifact-1/abc');
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.body.toString(), 'durable report');
    assert.match(request.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=access-key\//);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      SOURCE_ARTIFACT_BUCKET: original.bucket,
      SOURCE_ARTIFACT_ENDPOINT: original.endpoint,
      SOURCE_ARTIFACT_ACCESS_KEY: original.accessKey,
      SOURCE_ARTIFACT_SECRET_KEY: original.secretKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('object storage reads a bounded private artifact using a signed GET', async () => {
  const original = {
    bucket: process.env.SOURCE_ARTIFACT_BUCKET,
    endpoint: process.env.SOURCE_ARTIFACT_ENDPOINT,
    accessKey: process.env.SOURCE_ARTIFACT_ACCESS_KEY,
    secretKey: process.env.SOURCE_ARTIFACT_SECRET_KEY,
  };
  const originalFetch = globalThis.fetch;
  process.env.SOURCE_ARTIFACT_BUCKET = 'hive-artifacts';
  process.env.SOURCE_ARTIFACT_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
  process.env.SOURCE_ARTIFACT_ACCESS_KEY = 'access-key';
  process.env.SOURCE_ARTIFACT_SECRET_KEY = 'secret-key';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'text/plain' : null) },
      arrayBuffer: async () => Buffer.from('durable report'),
    };
  };

  try {
    const store = new SourceArtifactBackup({ logger: { info() {}, warn() {} } });
    const loaded = await store.read({ key: 'org/org-1/workruns/run-1/artifacts/artifact-1/abc' });
    assert.equal(loaded.found, true);
    assert.equal(loaded.bytes.toString(), 'durable report');
    assert.equal(loaded.contentType, 'text/plain');
    assert.equal(request.options.method, 'GET');
    assert.match(request.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=access-key\//);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      SOURCE_ARTIFACT_BUCKET: original.bucket,
      SOURCE_ARTIFACT_ENDPOINT: original.endpoint,
      SOURCE_ARTIFACT_ACCESS_KEY: original.accessKey,
      SOURCE_ARTIFACT_SECRET_KEY: original.secretKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
