import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FIXTURE_PATH = '/home/user/hivemind-e2b-canary.html'

const fixtureHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>HIVE-MIND E2B canary</title>
<style>body{font:16px system-ui;margin:48px;max-width:720px}input{width:100%;padding:12px;font:inherit}button{margin-top:16px;padding:10px 14px}</style>
<h1>E2B computer-use canary</h1>
<p>This local fixture makes no network request and cannot submit externally.</p>
<label>Draft <input id="draft" autofocus placeholder="Agent draft appears here"></label>
<button type="button" disabled>External submit disabled</button>
<script>document.querySelector('#draft').focus()</script>
</html>`

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requireDesktopApi(desktop) {
  for (const method of ['launch', 'open', 'wait', 'write', 'screenshot', 'kill']) {
    if (typeof desktop?.[method] !== 'function') throw new TypeError(`E2B Desktop is missing ${method}()`)
  }
  if (typeof desktop?.files?.write !== 'function') throw new TypeError('E2B Desktop is missing files.write()')
  if (typeof desktop?.stream?.start !== 'function' || typeof desktop?.stream?.getAuthKey !== 'function' || typeof desktop?.stream?.getUrl !== 'function') {
    throw new TypeError('E2B Desktop is missing authenticated stream APIs')
  }
}

export async function runDesktopCanary({
  Sandbox,
  outputDir,
  keepAlive = false,
  printStreamUrl = false,
  now = () => new Date(),
  log = console.log,
} = {}) {
  if (!Sandbox?.create) throw new TypeError('Sandbox.create() is required')
  if (!outputDir) throw new TypeError('outputDir is required')

  await mkdir(outputDir, { recursive: true })
  const startedAt = now().toISOString()
  let desktop
  let receipt

  try {
    desktop = await Sandbox.create()
    requireDesktopApi(desktop)
    await desktop.launch('google-chrome')
    await desktop.files.write(FIXTURE_PATH, fixtureHtml)
    await desktop.open(FIXTURE_PATH)
    await desktop.wait(1_000)
    await desktop.write('Agent draft: awaiting human review')

    await desktop.stream.start({ requireAuth: true })
    const authKey = await desktop.stream.getAuthKey()
    const streamUrl = desktop.stream.getUrl({ authKey })
    if (printStreamUrl) log(`Interactive E2B stream URL (do not share): ${streamUrl}`)

    const screenshot = Buffer.from(await desktop.screenshot())
    const screenshotPath = path.join(outputDir, 'desktop.png')
    await writeFile(screenshotPath, screenshot)
    receipt = {
      contract: 'hivemind.e2b-desktop-canary.v1',
      started_at: startedAt,
      finished_at: now().toISOString(),
      sandbox_id: String(desktop.sandboxId ?? desktop.id ?? 'unknown'),
      chrome_launched: true,
      agent_draft_written: true,
      interactive_stream_started: true,
      stream_auth_key_persisted: false,
      stream_url_persisted: false,
      fixture_network_disabled: true,
      screenshot: {
        path: screenshotPath,
        bytes: screenshot.byteLength,
        sha256: sha256(screenshot),
      },
      status: keepAlive ? 'awaiting_human_takeover' : 'completed',
    }
    await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    return { receipt, streamUrl: printStreamUrl ? streamUrl : undefined, desktop }
  } finally {
    if (desktop && !keepAlive) await desktop.kill()
  }
}
