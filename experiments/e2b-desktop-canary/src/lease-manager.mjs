import { randomUUID } from 'node:crypto'

const ACTIVE = new Set(['starting', 'agent', 'human'])
const TRANSITIONS = {
  starting: new Set(['agent', 'failed', 'released']),
  agent: new Set(['human', 'paused', 'failed', 'released']),
  human: new Set(['agent', 'paused', 'failed', 'released']),
  paused: new Set(['agent', 'failed', 'released']),
  failed: new Set(['released']),
  released: new Set(),
}

export class ComputerLeaseManager {
  constructor({ maxActive = 3, now = () => new Date().toISOString() } = {}) {
    this.maxActive = maxActive
    this.now = now
    this.leases = new Map()
    this.waiters = []
  }

  activeCount() { return [...this.leases.values()].filter(lease => ACTIVE.has(lease.status)).length }

  async acquire(owner, sandboxId = null) {
    if (this.activeCount() >= this.maxActive) {
      return new Promise(resolve => this.waiters.push({ owner, sandboxId, resolve }))
    }
    return this.#create(owner, sandboxId)
  }

  async release(leaseId) {
    const lease = this.transition(leaseId, 'released')
    const next = this.waiters.shift()
    if (next) next.resolve(this.#create(next.owner, next.sandboxId))
    return lease
  }

  transition(leaseId, status) {
    const lease = this.require(leaseId)
    if (!TRANSITIONS[lease.status].has(status)) throw new Error(`invalid lease transition: ${lease.status} -> ${status}`)
    lease.status = status
    lease.lastActionAt = this.now()
    return { ...lease }
  }

  assignSandbox(leaseId, sandboxId) {
    const lease = this.require(leaseId)
    if (lease.status !== 'starting') throw new Error(`cannot assign sandbox while lease is ${lease.status}`)
    lease.sandboxId = sandboxId
    lease.lastActionAt = this.now()
    return { ...lease }
  }

  assertAgentMayMutate(leaseId) {
    const lease = this.require(leaseId)
    if (lease.status === 'human') {
      const error = new Error('computer_locked_by_human')
      error.code = 'computer_locked_by_human'
      throw error
    }
    if (lease.status !== 'agent') throw new Error(`computer_not_available:${lease.status}`)
  }

  require(leaseId) {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new Error(`unknown lease: ${leaseId}`)
    return lease
  }

  #create(owner, sandboxId) {
    const createdAt = this.now()
    const lease = { leaseId: randomUUID(), sandboxId, owner, status: 'starting', createdAt, lastActionAt: createdAt }
    this.leases.set(lease.leaseId, lease)
    return { ...lease }
  }
}
