import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const template = process.env.E2B_TEMPLATE_NAME ?? 'hm-computer-operator-canary-v4'
const useJev = process.env.HM_JEV_CANARY === '1'
const jevModel = process.env.HM_JEV_MODEL ?? '~typesafe/jev-latest'
if (useJev && (!process.env.HM_JEV_DECISIONS_URL || !process.env.HM_JEV_GATEWAY_TOKEN || (!process.env.HM_JEV_BYOK_ALIAS && !process.env.HM_JEV_PROVIDER_API_KEY))) {
  throw new Error('HM_JEV_CANARY requires the Cloudflare Gateway route and credential plus either a BYOK alias or provider credential; never commit or log values.')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'evidence', new Date().toISOString().replaceAll(':', '-'))
const fixturePath = '/home/user/hm-computer-worker/profile.html'
const chromeLog = '/tmp/hm-computer-operator-chrome.log'
const workerLog = '/tmp/hm-computer-operator-worker.log'
const phase = name => console.log(JSON.stringify({ phase: name }))

const fixture = `<!doctype html><meta charset="utf-8"><title>Acme profile</title>
<h1>Acme Corp</h1>
<a id="following" href="#following">243 Following</a>
<a id="followers" href="#followers">18,402 Followers</a>
<script>
document.querySelector('#followers').addEventListener('click', event => {
  event.preventDefault()
  document.title = 'Acme followers'
  document.body.innerHTML = '<h1>Followers</h1><p id="follower-count">18,402</p>'
})
</script>`

await mkdir(outputDir, { recursive: true })
let desktop
let chrome
try {
  phase('create_desktop')
  desktop = await Sandbox.create(template, {
    // The deterministic fixture remains network-isolated. The one Jev request
    // needs egress to the existing Cloudflare Gateway custom-provider route.
    allowInternetAccess: useJev,
    timeoutMs: 5 * 60_000,
    requestTimeoutMs: 60_000,
    metadata: { app: 'hivemind', test: 'dom-operator-canary-v1' },
  })
  phase('write_fixture')
  await desktop.files.write(fixturePath, fixture)

  // A background E2B command owns this Chrome process until the canary is
  // complete; `nohup ... &` is deliberately avoided because child-process
  // lifetime is then shell-dependent.
  phase('start_chrome')
  chrome = await desktop.commands.run(
    `google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/home/user/hm-computer-worker/chrome-profile --no-first-run --no-default-browser-check about:blank >${chromeLog} 2>&1`,
    { background: true, timeoutMs: 5 * 60_000, envs: { DISPLAY: ':0' } },
  )
  phase('wait_for_cdp')
  const cdpReady = await desktop.waitAndVerify(
    'curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:9222/json/version >/dev/null',
    result => (result.exitCode ?? result.exit_code) === 0,
    // @e2b/desktop's waitAndVerify accepts seconds, unlike the rest of the
    // SDK's millisecond durations.
    30,
    1,
  )
  if (!cdpReady) {
    const log = await desktop.commands.run(`tail -c 2000 ${chromeLog} || true`, { timeoutMs: 5_000 })
    throw new Error(`Chrome CDP endpoint did not become ready: ${String(log.stdout).trim()}`)
  }

  phase('run_worker')
  // E2B's RPC timeout does not itself kill the remote process or return its
  // partial output. Bound the process inside the microVM so a failed worker
  // yields diagnostics and cannot consume an acquired computer indefinitely.
  const run = await desktop.commands.run(
    `timeout --signal=TERM --kill-after=5s 45s node canary.mjs >${workerLog} 2>&1; status=$?; cat ${workerLog}; printf '\\n__HM_WORKER_EXIT=%s\\n' \"$status\"`,
    {
    cwd: '/home/user/hm-computer-worker',
    timeoutMs: 60_000,
    envs: {
      DISPLAY: ':0',
      HM_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      ...(useJev ? {
        HM_JEV_CANARY: '1',
        HM_JEV_DECISIONS_URL: process.env.HM_JEV_DECISIONS_URL,
        HM_JEV_GATEWAY_TOKEN: process.env.HM_JEV_GATEWAY_TOKEN,
        ...(process.env.HM_JEV_BYOK_ALIAS ? { HM_JEV_BYOK_ALIAS: process.env.HM_JEV_BYOK_ALIAS } : {}),
        ...(process.env.HM_JEV_PROVIDER_API_KEY ? { HM_JEV_PROVIDER_API_KEY: process.env.HM_JEV_PROVIDER_API_KEY } : {}),
        HM_JEV_MODEL: jevModel,
      } : {}),
    },
    },
  )
  phase('capture_evidence')
  const workerOutput = String(run.stdout)
  const workerExit = Number(workerOutput.match(/__HM_WORKER_EXIT=(\d+)/)?.[1])
  if (workerExit !== 0) throw new Error(`DOM worker failed with exit ${workerExit}: ${workerOutput.slice(-2000)}`)
  const result = workerOutput
    .trim()
    .split('\n')
    .map(line => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(payload => payload?.status)
    .at(-1)
  if (!result) throw new Error('DOM worker completed without a structured result')
  const screenshot = Buffer.from(await desktop.screenshot())
  const screenshotPath = path.join(outputDir, 'desktop.png')
  await writeFile(screenshotPath, screenshot)
  const receipt = {
    contract: 'hivemind.e2b-dom-operator-canary.v1',
    sandbox_id: desktop.sandboxId,
    template,
    decision: useJev ? { provider: 'cloudflare-custom-openrouter', model: jevModel, mode: 'ambiguous-dom-only' } : { provider: 'deterministic' },
    result,
    screenshot: { path: screenshotPath, sha256: createHash('sha256').update(screenshot).digest('hex') },
    status: result.status,
  }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ status: receipt.status, sandbox_id: receipt.sandbox_id, receipt_path: path.join(outputDir, 'receipt.json'), screenshot_path: screenshotPath }, null, 2))
} catch (error) {
  // A decision-provider failure is evidence too. Preserve a deliberately
  // compact, secret-free receipt so a caller can distinguish a safe stop from
  // a missing browser action. Do not serialize provider responses or headers.
  const message = String(error?.message || 'unknown DOM canary failure')
    .replace(/Bearer\s+[^\s]+/ig, 'Bearer [redacted]')
    .slice(0, 500)
  const receipt = {
    contract: 'hivemind.e2b-dom-operator-canary.v1',
    sandbox_id: desktop?.sandboxId ?? null,
    template,
    decision: useJev ? { provider: 'cloudflare-custom-openrouter', model: jevModel, mode: 'ambiguous-dom-only' } : { provider: 'deterministic' },
    status: 'failed_closed',
    error: { code: 'dom_canary_failed', message },
  }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.error(JSON.stringify({ status: receipt.status, receipt_path: path.join(outputDir, 'receipt.json'), error: receipt.error.code }))
  throw error
} finally {
  await chrome?.kill().catch(() => {})
  await desktop?.kill().catch(() => {})
}
