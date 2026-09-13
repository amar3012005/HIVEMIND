import test from 'node:test';
import assert from 'node:assert/strict';
import { decideKbUploadPath, shouldRequireQueuedKbUploads } from '../../src/knowledge/upload-mode.js';

test('knowledge uploads always require the durable queue in every environment', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevFlag = process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS;
  process.env.NODE_ENV = 'test';
  delete process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS;
  try {
    assert.equal(shouldRequireQueuedKbUploads(), true);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevFlag === undefined) delete process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS;
    else process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS = prevFlag;
  }
});

test('knowledge upload mode is forced in production', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(shouldRequireQueuedKbUploads(), true);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

test('legacy queue feature flags cannot disable the durable ingestion boundary', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevFlag = process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS;
  process.env.NODE_ENV = 'test';
  process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS = 'false';
  try {
    assert.equal(shouldRequireQueuedKbUploads(), true);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevFlag === undefined) delete process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS;
    else process.env.HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS = prevFlag;
  }
});

test('knowledge upload decision rejects inline paths when queue is required', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = decideKbUploadPath({ queueEnabled: false, asyncRequested: true });
    assert.equal(result.mode, 'reject');
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'queue_unavailable');
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

test('knowledge upload decision uses queue when available', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = decideKbUploadPath({ queueEnabled: true, asyncRequested: false });
    assert.equal(result.mode, 'queue');
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});
