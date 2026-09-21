import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { E2BComputer, AGENT_DRAFT } from '../src/e2b-computer.mjs'
import { ComputerLeaseManager } from '../src/lease-manager.mjs'
import { ReceiptStore } from '../src/receipt-store.mjs'

function fakeDesktop(id) {
  const state = { id, title: 'HIVE draft: empty', launched: [], paused: false, killed: false, files: new Map(), streamStarted: false }
  return {
    sandboxId: id,
    state,
    files: { write: async (target, content) => state.files.set(target, content) },
    launch: async app => state.launched.push(app),
    wait: async () => {},
    leftClick: async () => {},
    write: async text => { if (!text.startsWith('file://')) state.title = `HIVE draft: ${text}` },
    press: async () => {},
    scroll: async () => {},
    screenshot: async () => Buffer.from(`image:${state.title}`),
    getCurrentWindowId: async () => `window-${id}`,
    getWindowTitle: async () => state.title,
    stream: {
      start: async () => { state.streamStarted = true }, stop: async () => { state.streamStarted = false },
      getAuthKey: async () => 'private-stream-key', getUrl: ({ authKey }) => `https://stream.example/${authKey}`,
    },
    pause: async () => { state.paused = true; return true },
    kill: async () => { state.killed = true; return true },
    commands: { run: async command => { state.lastCommand = command; return { exitCode: 1 } } },
  }
}

async function setup({ maxActive = 3 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2b-runtime-v1-'))
  const receipts = new ReceiptStore(root)
  const manager = new ComputerLeaseManager({ maxActive, now: () => '2026-09-21T12:00:00.000Z' })
  const sandboxes = new Map()
  let sequence = 0
  const Sandbox = {
    create: async options => {
      const desktop = fakeDesktop(`sandbox-${++sequence}`)
      desktop.state.createOptions = options
      sandboxes.set(desktop.sandboxId, desktop)
      return desktop
    },
    connect: async id => sandboxes.get(id),
  }
  return { root, receipts, manager, Sandbox, sandboxes }
}

test('same desktop supports agent, human edit, pause, controller reconnect, and receipt redaction', async () => {
  const { root, receipts, manager, Sandbox } = await setup()
  const computer = await E2BComputer.create({ Sandbox, leaseManager: manager, owner: 'canary', receipts, evidenceDir: path.join(root, 'artifacts'), metadata: { app: 'hivemind' }, allowInternetAccess: false })
  await computer.prepareSafeFixture()
  await computer.writeDraft(AGENT_DRAFT)
  const url = await computer.startHumanStream()
  assert.match(url, /private-stream-key/)
  assert.throws(() => manager.assertAgentMayMutate(computer.leaseId), /computer_locked_by_human/)
  computer.desktop.state.title = `HIVE draft: ${AGENT_DRAFT} HUMAN EDIT.`
  await computer.stopHumanStream()
  await computer.pause()
  const persistedLease = await receipts.loadLease()
  const reconnected = await E2BComputer.connect({ Sandbox, lease: persistedLease, leaseManager: new ComputerLeaseManager(), receipts, evidenceDir: path.join(root, 'artifacts') })
  const observed = await reconnected.observe('human-edit')
  assert.equal(reconnected.desktop.sandboxId, computer.desktop.sandboxId)
  assert.match(observed.title, /HUMAN EDIT\./)
  assert.equal(reconnected.desktop.state.paused, true)
  assert.equal(reconnected.desktop.state.createOptions.allowInternetAccess, false)
  const stored = await readFile(path.join(root, 'action-receipts.jsonl'), 'utf8')
  assert.doesNotMatch(stored, /private-stream-key|stream\.example/)
  await reconnected.kill()
})

test('three leases isolate state and fourth waits until capacity releases', async () => {
  const { root, receipts, manager, Sandbox } = await setup({ maxActive: 3 })
  const computers = await Promise.all(['A', 'B', 'C'].map(async name => {
    const computer = await E2BComputer.create({ Sandbox, leaseManager: manager, owner: name, receipts, evidenceDir: path.join(root, name), metadata: { app: 'hivemind', lease: name } })
    await computer.prepareSafeFixture(); await computer.writeDraft(`computer-${name}-secret`)
    return computer
  }))
  let granted = false
  const fourth = manager.acquire('D').then(lease => { granted = true; return lease })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(granted, false)
  const titles = await Promise.all(computers.map(computer => computer.observe('isolation')))
  assert.deepEqual(titles.map(item => item.title).sort(), ['HIVE draft: computer-A-secret', 'HIVE draft: computer-B-secret', 'HIVE draft: computer-C-secret'])
  await computers[1].kill()
  const leaseD = await fourth
  assert.equal(leaseD.owner, 'D')
  assert.equal(manager.activeCount(), 3)
  await Promise.all([computers[0].kill(), computers[2].kill()])
})

test('browser recovery runs once and controller crash marks in-flight receipt unknown without replay', async () => {
  const { root, receipts, manager, Sandbox } = await setup()
  const computer = await E2BComputer.create({ Sandbox, leaseManager: manager, owner: 'canary', receipts, evidenceDir: path.join(root, 'artifacts') })
  await computer.prepareSafeFixture()
  const recovery = await computer.recoverBrowserOnce()
  assert.equal(recovery.status, 'completed')
  assert.equal(recovery.recovery_attempts, 1)
  assert.equal(computer.desktop.state.lastCommand, 'pkill -f chrome')
  const network = await computer.verifyNetworkProfile({ expectInternet: false })
  assert.equal(network.network_reachable, false)
  await receipts.record({ id: 'action-interrupted', status: 'started', action: 'publish', input: { text: 'not persisted' } })
  const unknown = await receipts.markInflightUnknown()
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].status, 'unknown_outcome')
  assert.equal((await receipts.markInflightUnknown()).length, 0)
  await computer.kill()
})
