import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2BComputer } from './e2b-computer.mjs'
import { ComputerLeaseManager } from './lease-manager.mjs'
import { ReceiptStore } from './receipt-store.mjs'

const leasePath = process.argv[2]
if (!leasePath) throw new Error('Usage: npm run resume -- /absolute/path/to/lease.json')
if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')
const { Sandbox } = await import('@e2b/desktop')
const receipts = new ReceiptStore(path.dirname(leasePath))
const lease = await receipts.loadLease()
const manager = new ComputerLeaseManager()
const computer = await E2BComputer.connect({ Sandbox, lease, leaseManager: manager, receipts, evidenceDir: path.join(path.dirname(leasePath), 'artifacts') })
try {
  if (!await computer.desktop.isRunning()) throw new Error('Reconnected sandbox is not running.')
  const observed = await computer.observe('reconnected')
  if (!/human edit\./i.test(observed.title)) throw new Error('Expected human edit is absent after controller reconnect.')
  console.log(JSON.stringify({ status: 'reconnect_verified', sandbox_id: computer.desktop.sandboxId, title: observed.title, screenshot_path: observed.screenshot_after }, null, 2))
} finally {
  await computer.kill()
}
