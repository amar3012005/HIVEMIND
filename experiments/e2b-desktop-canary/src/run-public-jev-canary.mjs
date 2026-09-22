import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')
if (!process.env.HM_JEV_API_KEY) throw new Error('HM_JEV_API_KEY is required for the opt-in direct OpenRouter public canary; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const template = process.env.E2B_TEMPLATE_NAME ?? 'hm-computer-operator-canary-v5'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'evidence', new Date().toISOString().replaceAll(':', '-'))
const chromeLog = '/tmp/hm-public-jev-chrome.log'
const workerLog = '/tmp/hm-public-jev-worker.log'
const phase = name => console.log(JSON.stringify({ phase: name }))

await mkdir(outputDir, { recursive: true })
let desktop
let chrome
try {
  phase('create_desktop')
  desktop = await Sandbox.create(template, {
    allowInternetAccess: true,
    timeoutMs: 5 * 60_000,
    requestTimeoutMs: 60_000,
    metadata: { app: 'hivemind', test: 'public-jev-read-only-v1' },
  })
  phase('start_chrome')
  chrome = await desktop.commands.run(
    `google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/home/user/hm-computer-worker/chrome-profile --no-first-run --no-default-browser-check about:blank >${chromeLog} 2>&1`,
    { background: true, timeoutMs: 5 * 60_000, envs: { DISPLAY: ':0' } },
  )
  phase('wait_for_cdp')
  const cdpReady = await desktop.waitAndVerify(
    'curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:9222/json/version >/dev/null',
    result => (result.exitCode ?? result.exit_code) === 0,
    30,
    1,
  )
  if (!cdpReady) throw new Error('Chrome CDP endpoint did not become ready')

  phase('run_public_worker')
  const run = await desktop.commands.run(
    `timeout --signal=TERM --kill-after=5s 60s node public-jev-canary.mjs >${workerLog} 2>&1; status=$?; cat ${workerLog}; printf '\n__HM_WORKER_EXIT=%s\n' "$status"`,
    {
      cwd: '/home/user/hm-computer-worker',
      timeoutMs: 75_000,
      envs: {
        DISPLAY: ':0',
        HM_CDP_ENDPOINT: 'http://127.0.0.1:9222',
        HM_JEV_API_KEY: process.env.HM_JEV_API_KEY,
        HM_JEV_DECISIONS_URL: process.env.HM_JEV_DECISIONS_URL ?? 'https://openrouter.ai/api/alpha/decisions',
      },
    },
  )
  phase('capture_evidence')
  const workerOutput = String(run.stdout)
  const workerExit = Number(workerOutput.match(/__HM_WORKER_EXIT=(\d+)/)?.[1])
  if (workerExit !== 0) throw new Error(`Public Jev worker failed with exit ${workerExit}: ${workerOutput.slice(-1200)}`)
  const result = workerOutput.trim().split('\n').map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(payload => payload?.status).at(-1)
  if (!result) throw new Error('Public Jev worker completed without a structured result')
  if (result.result?.decision?.calls !== 1 || result.result?.verification?.independent_http !== true) {
    throw new Error('Public Jev canary did not produce one decision and independent verification')
  }
  const screenshot = Buffer.from(await desktop.screenshot())
  const screenshotPath = path.join(outputDir, 'desktop.png')
  await writeFile(screenshotPath, screenshot)
  const receipt = {
    contract: 'hivemind.e2b-public-jev-read-only-canary.v1',
    sandbox_id: desktop.sandboxId,
    template,
    status: result.status,
    result,
    screenshot: { path: screenshotPath, sha256: createHash('sha256').update(screenshot).digest('hex') },
  }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ status: receipt.status, sandbox_id: receipt.sandbox_id, receipt_path: path.join(outputDir, 'receipt.json'), screenshot_path: screenshotPath }, null, 2))
} catch (error) {
  const message = String(error?.message || 'unknown public Jev canary failure').replace(/Bearer\s+[^\s]+/ig, 'Bearer [redacted]').slice(0, 500)
  const receipt = { contract: 'hivemind.e2b-public-jev-read-only-canary.v1', sandbox_id: desktop?.sandboxId ?? null, template, status: 'failed_closed', error: { code: 'public_jev_canary_failed', message } }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.error(JSON.stringify({ status: receipt.status, receipt_path: path.join(outputDir, 'receipt.json'), error: receipt.error.code }))
  throw error
} finally {
  await chrome?.kill().catch(() => {})
  await desktop?.kill().catch(() => {})
}
