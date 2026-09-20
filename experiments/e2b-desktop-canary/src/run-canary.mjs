import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktopCanary } from './e2b-desktop-canary.mjs'

if (!process.env.E2B_API_KEY) {
  throw new Error('E2B_API_KEY is required. Set it only in this process environment; never commit it.')
}

const { Sandbox } = await import('@e2b/desktop')
const root = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.resolve(root, '..', 'evidence', new Date().toISOString().replaceAll(':', '-'))
const keepAlive = process.env.E2B_KEEP_ALIVE === '1'
const printStreamUrl = process.env.E2B_PRINT_STREAM_URL === '1'

const { receipt } = await runDesktopCanary({
  Sandbox,
  outputDir,
  keepAlive,
  printStreamUrl,
})

console.log(JSON.stringify({
  status: receipt.status,
  sandbox_id: receipt.sandbox_id,
  receipt_path: path.join(outputDir, 'receipt.json'),
  screenshot_path: receipt.screenshot.path,
}, null, 2))
