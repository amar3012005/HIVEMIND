import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const FIXTURE_PATH = '/home/user/hivemind-safe-social-draft.html'
export const AGENT_DRAFT = 'Agent draft: awaiting human review.'

export const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>HIVE draft: empty</title>
<style>body{font:16px system-ui;margin:48px;max-width:720px}input{box-sizing:border-box;width:100%;padding:12px;font:inherit}button{margin-top:16px;padding:10px 14px}</style>
<h1>Safe social draft</h1><p>Local-only fixture. Publishing is permanently disabled.</p>
<label>Research draft <input id="draft" autofocus></label><button disabled>Publish disabled</button>
<script>const input=document.querySelector('#draft');input.addEventListener('input',()=>document.title='HIVE draft: '+input.value);input.focus()</script>`

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function requireMethod(value, method) { if (typeof value?.[method] !== 'function') throw new TypeError(`E2B desktop is missing ${method}()`) }

export class E2BComputer {
  constructor({ desktop, leaseManager, leaseId, receipts, evidenceDir, now = () => new Date().toISOString() }) {
    this.desktop = desktop
    this.leaseManager = leaseManager
    this.leaseId = leaseId
    this.receipts = receipts
    this.evidenceDir = evidenceDir
    this.now = now
  }

  static async create({ Sandbox, leaseManager, owner, receipts, evidenceDir, metadata = {}, allowInternetAccess = false, timeoutMs = 15 * 60_000, now }) {
    const lease = await leaseManager.acquire(owner)
    try {
      const desktop = await Sandbox.create({ metadata, allowInternetAccess, timeoutMs })
      leaseManager.assignSandbox(lease.leaseId, desktop.sandboxId)
      const computer = new E2BComputer({ desktop, leaseManager, leaseId: lease.leaseId, receipts, evidenceDir, now })
      await computer.persistLease()
      leaseManager.transition(lease.leaseId, 'agent')
      await computer.persistLease()
      return computer
    } catch (error) {
      await leaseManager.release(lease.leaseId)
      throw error
    }
  }

  static async connect({ Sandbox, lease, leaseManager, receipts, evidenceDir, now }) {
    const desktop = await Sandbox.connect(lease.sandboxId)
    if (!leaseManager.leases.has(lease.leaseId)) leaseManager.leases.set(lease.leaseId, lease)
    const computer = new E2BComputer({ desktop, leaseManager, leaseId: lease.leaseId, receipts, evidenceDir, now })
    if (leaseManager.require(lease.leaseId).status === 'paused') leaseManager.transition(lease.leaseId, 'agent')
    await computer.persistLease()
    return computer
  }

  async prepareSafeFixture() {
    requireMethod(this.desktop.files, 'write'); requireMethod(this.desktop, 'launch'); requireMethod(this.desktop, 'wait')
    await this.desktop.files.write(FIXTURE_PATH, fixtureHtml)
    // Launch Chrome directly at the fixture. Keyboard navigation from a Chrome
    // new-tab page is not deterministic across desktop images.
    await this.desktop.launch('google-chrome', `file://${FIXTURE_PATH}`)
    await this.desktop.wait(10_000)
  }

  async openUrl(url, { record = true } = {}) {
    return this.#mutate('open_url', { url }, async () => {
      await this.desktop.press(['ctrl', 'l']); await this.desktop.write(url); await this.desktop.press('enter'); await this.desktop.wait(1_000)
    }, { record })
  }

  async click(x, y) { return this.#mutate('click', { x, y }, () => this.desktop.leftClick(x, y)) }
  async type(text) { return this.#mutate('type', { text_length: text.length }, () => this.desktop.write(text)) }
  async key(key) { return this.#mutate('key', { key }, () => this.desktop.press(key)) }
  async scroll(direction, amount) { return this.#mutate('scroll', { direction, amount }, () => this.desktop.scroll(direction, amount)) }

  async writeDraft(text = AGENT_DRAFT) { await this.click(220, 260); await this.type(text) }

  async observe(label = 'observe') {
    requireMethod(this.desktop, 'screenshot'); requireMethod(this.desktop, 'getCurrentWindowId'); requireMethod(this.desktop, 'getWindowTitle')
    await mkdir(this.evidenceDir, { recursive: true })
    const bytes = Buffer.from(await this.desktop.screenshot())
    const screenshot = path.join(this.evidenceDir, `${label}-${randomUUID()}.png`)
    await writeFile(screenshot, bytes)
    const windowId = await this.desktop.getCurrentWindowId()
    return { screenshot_after: screenshot, screenshot_sha256: sha256(bytes), title: await this.desktop.getWindowTitle(windowId) }
  }

  async startHumanStream() {
    this.leaseManager.transition(this.leaseId, 'human'); await this.persistLease()
    await this.desktop.stream.start({ requireAuth: true })
    const authKey = await this.desktop.stream.getAuthKey()
    // Returned only in memory to a caller that opens it locally. Never receipt/log it.
    return this.desktop.stream.getUrl({ authKey, autoConnect: true })
  }

  async stopHumanStream() {
    if (typeof this.desktop.stream?.stop === 'function') await this.desktop.stream.stop()
    this.leaseManager.transition(this.leaseId, 'agent'); await this.persistLease()
  }

  async pause() { await this.desktop.pause({ keepMemory: true }); this.leaseManager.transition(this.leaseId, 'paused'); await this.persistLease() }
  async kill() {
    if (this.leaseManager.require(this.leaseId).status !== 'released') await this.leaseManager.release(this.leaseId)
    await this.persistLease()
    return this.desktop.kill()
  }
  async persistLease() { return this.receipts.saveLease(this.leaseManager.require(this.leaseId)) }

  async recoverBrowserOnce() {
    const receipt = await this.#startReceipt('browser_recovery', {})
    try {
      await this.desktop.commands.run('pkill -f chrome')
      await this.desktop.launch('google-chrome', `file://${FIXTURE_PATH}`)
      await this.desktop.wait(5_000)
      return await this.receipts.record({ ...receipt, status: 'completed', completed_at: this.now(), recovery_attempts: 1, page: await this.observe('browser-recovered') })
    } catch (error) {
      await this.leaseManager.transition(this.leaseId, 'failed'); await this.persistLease()
      return this.receipts.record({ ...receipt, status: 'failed', completed_at: this.now(), error: String(error.message), recovery_attempts: 1 })
    }
  }

  async verifyNetworkProfile({ expectInternet = false } = {}) {
    const result = await this.desktop.commands.run('curl --connect-timeout 5 --max-time 10 -fsS https://example.com >/dev/null')
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : result?.exit_code
    const reachable = exitCode === 0
    if (reachable !== expectInternet) throw new Error(expectInternet ? 'external web request failed' : 'external web request unexpectedly succeeded')
    return this.receipts.record({
      id: `action_${randomUUID()}`, lease_id: this.leaseId, sandbox_id: this.desktop.sandboxId,
      action: 'verify_network_policy', input: { expect_internet: expectInternet }, status: 'completed',
      started_at: this.now(), completed_at: this.now(), network_reachable: reachable,
    })
  }

  async #mutate(action, input, operation, { record = true } = {}) {
    this.leaseManager.assertAgentMayMutate(this.leaseId)
    if (!record) return operation()
    const receipt = await this.#startReceipt(action, input)
    try {
      await operation()
      return await this.receipts.record({ ...receipt, status: 'completed', completed_at: this.now(), page: await this.observe(action) })
    } catch (error) {
      return this.receipts.record({ ...receipt, status: 'failed', completed_at: this.now(), error: String(error.message) })
    }
  }

  async #startReceipt(action, input) {
    const receipt = { id: `action_${randomUUID()}`, lease_id: this.leaseId, sandbox_id: this.desktop.sandboxId, action, input, status: 'started', started_at: this.now() }
    await this.receipts.record(receipt)
    return receipt
  }
}
