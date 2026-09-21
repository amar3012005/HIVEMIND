import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'

const SECRET_KEY = /(?:api[_-]?key|auth|cookie|otp|password|secret|token)/i
const SECRET_VALUE = /(?:e2b_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/g

export function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]')
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]))
  return value
}

export class ReceiptStore {
  constructor(root) {
    this.root = root
    this.receiptPath = path.join(root, 'action-receipts.jsonl')
    this.leasePath = path.join(root, 'lease.json')
  }

  async init() { await mkdir(this.root, { recursive: true }) }

  async saveLease(lease) {
    await this.init()
    await writeFile(this.leasePath, `${JSON.stringify(redact(lease), null, 2)}\n`)
  }

  async loadLease() { return JSON.parse(await readFile(this.leasePath, 'utf8')) }

  async record(receipt) {
    await this.init()
    const safeReceipt = redact(receipt)
    await appendFile(this.receiptPath, `${JSON.stringify(safeReceipt)}\n`)
    return safeReceipt
  }

  async receipts() {
    try {
      const lines = (await readFile(this.receiptPath, 'utf8')).trim().split('\n').filter(Boolean)
      return lines.map(JSON.parse)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async markInflightUnknown() {
    const all = await this.receipts()
    const terminal = new Set(all.filter(receipt => ['completed', 'failed', 'unknown_outcome'].includes(receipt.status)).map(receipt => receipt.id))
    const changed = []
    for (const receipt of all.filter(receipt => receipt.status === 'started' && !terminal.has(receipt.id))) {
      changed.push(await this.record({ ...receipt, status: 'unknown_outcome', completed_at: new Date().toISOString() }))
    }
    return changed
  }
}
