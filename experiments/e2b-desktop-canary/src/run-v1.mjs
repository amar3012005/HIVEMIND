import { mkdir } from 'node:fs/promises'
import http from 'node:http'
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
    if (/human edit\./i.test(title)) return title
    await computer.desktop.wait(2_000)
  }
  throw new Error('Timed out waiting for a human edit in the same Chrome session.')
}

function startLocalOneTimeRedirect(streamUrl, port = 48131) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/') return response.writeHead(404).end()
      response.writeHead(302, { location: streamUrl, 'cache-control': 'no-store' }).end()
      server.close()
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

let redirectServer
try {
  await computer.prepareSafeFixture()
  await computer.writeDraft(AGENT_DRAFT)
  const streamUrl = await computer.startHumanStream()
  redirectServer = await startLocalOneTimeRedirect(streamUrl)
  // The E2B URL and auth key stay process-local; only a loopback one-time
  // redirect is announced for the human's browser.
  console.log('Open http://127.0.0.1:48131/ in your current browser. It redirects once to the authenticated E2B stream, then expires.')
  console.log('Waiting up to five minutes for the human edit in the same Chrome session.')
  await waitForHumanEdit()
  await computer.stopHumanStream()
  const observed = await computer.observe('human-edit')
  if (!/human edit\./i.test(observed.title)) throw new Error('Human edit was not observable in the same Chrome session.')
  await computer.pause()
  console.log(JSON.stringify({ status: 'paused_for_reconnect', lease_path: receipts.leasePath, sandbox_id: computer.desktop.sandboxId }, null, 2))
  console.log('Run `npm run resume -- <lease-path>` in a new controller process to reconnect and verify, then kill the sandbox.')
} catch (error) {
  redirectServer?.close()
  await computer.kill().catch(() => {})
  throw error
}
