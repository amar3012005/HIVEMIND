import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runDesktopCanary } from '../src/e2b-desktop-canary.mjs'

test('records a non-secret E2B computer-use receipt and releases the sandbox', async () => {
  const calls = []
  let killed = false
  const desktop = {
    sandboxId: 'sandbox-test-1',
    launch: async value => calls.push(['launch', value]),
    files: { write: async (target, content) => calls.push(['file', target, content]) },
    open: async target => calls.push(['open', target]),
    wait: async ms => calls.push(['wait', ms]),
    write: async value => calls.push(['write', value]),
    screenshot: async () => Buffer.from('fake-png'),
    stream: {
      start: async options => calls.push(['stream', options]),
      getAuthKey: async () => 'private-stream-key',
      getUrl: ({ authKey }) => `https://stream.example/${authKey}`,
    },
    kill: async () => { killed = true },
  }
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'e2b-canary-'))
  const { receipt, streamUrl } = await runDesktopCanary({
    Sandbox: { create: async () => desktop },
    outputDir,
    now: () => new Date('2026-09-21T12:00:00.000Z'),
    log: () => assert.fail('stream URL must not be logged by default'),
  })

  assert.equal(killed, true)
  assert.equal(streamUrl, undefined)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.stream_auth_key_persisted, false)
  assert.equal(receipt.stream_url_persisted, false)
  assert.equal(receipt.fixture_network_disabled, true)
  assert.deepEqual(calls.map(([name]) => name), ['launch', 'file', 'open', 'wait', 'write', 'stream'])
  const persisted = await readFile(path.join(outputDir, 'receipt.json'), 'utf8')
  assert.doesNotMatch(persisted, /private-stream-key|stream\.example/)
})

test('keeps the desktop alive only when explicitly requested', async () => {
  let killed = false
  const desktop = {
    id: 'sandbox-test-2', launch: async () => {}, open: async () => {}, wait: async () => {}, write: async () => {}, screenshot: async () => Buffer.from('png'),
    files: { write: async () => {} }, stream: { start: async () => {}, getAuthKey: async () => 'secret', getUrl: () => 'https://stream.example/secret' },
    kill: async () => { killed = true },
  }
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'e2b-canary-'))
  const { receipt } = await runDesktopCanary({ Sandbox: { create: async () => desktop }, outputDir, keepAlive: true })
  assert.equal(killed, false)
  assert.equal(receipt.status, 'awaiting_human_takeover')
})
