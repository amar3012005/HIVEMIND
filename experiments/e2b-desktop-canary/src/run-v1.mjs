import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2BComputer, AGENT_DRAFT } from './e2b-computer.mjs'
import { ComputerLeaseManager } from './lease-manager.mjs'
import { ReceiptStore } from './receipt-store.mjs'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runDir = path.join(root, 'receipts', new Date().toISOString().replaceAll(':', '-'))
await mkdir(runDir, { recursive: true })
const receipts = new ReceiptStore(runDir)
const manager = new ComputerLeaseManager()
const computer = await E2BComputer.create({
  Sandbox, leaseManager: manager, owner: 'manual-v1-canary', receipts,
  evidenceDir: path.join(runDir, 'artifacts'), metadata: { app: 'hivemind', test: 'computer-runtime-v1' }, allowInternetAccess: false,
})

async function waitForHumanEdit(timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const windowId = await computer.desktop.getCurrentWindowId()
    const title = await computer.desktop.getWindowTitle(windowId)
    if (title.includes('HUMAN EDIT.')) return title
    await computer.desktop.wait(2_000)
  }
  throw new Error('Timed out waiting for HUMAN EDIT. in the same Chrome session.')
}

try {
  await computer.prepareSafeFixture()
  await computer.writeDraft(AGENT_DRAFT)
  const streamUrl = await computer.startHumanStream()
  if (process.platform === 'darwin') {
    const { execFile } = await import('node:child_process')
    await new Promise((resolve, reject) => execFile('open', [streamUrl], error => error ? reject(error) : resolve()))
  }
  // The URL and auth key stay process-local; never write or print them.
  console.log('Authenticated stream opened locally. Waiting up to five minutes for the human edit in the same Chrome session.')
  await waitForHumanEdit()
  await computer.stopHumanStream()
  const observed = await computer.observe('human-edit')
  if (!observed.title.includes('HUMAN EDIT.')) throw new Error('Human edit was not observable in the same Chrome session.')
  await computer.pause()
  console.log(JSON.stringify({ status: 'paused_for_reconnect', lease_path: receipts.leasePath, sandbox_id: computer.desktop.sandboxId }, null, 2))
  console.log('Run `npm run resume -- <lease-path>` in a new controller process to reconnect and verify, then kill the sandbox.')
} catch (error) {
  await computer.kill().catch(() => {})
  throw error
}
