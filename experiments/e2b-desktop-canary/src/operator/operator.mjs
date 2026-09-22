import { createHash, randomUUID } from 'node:crypto'
import { chooseCandidate } from './decision.mjs'

const DEFAULT_LIMITS = Object.freeze({ maxSteps: 20, timeoutMs: 60_000, maxRepeatedStates: 3, minimumConfidence: 0.6 })

function nowIso(clock) { return new Date(clock()).toISOString() }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export function validateJob(job) {
  if (!job || typeof job !== 'object') throw new TypeError('computer job must be an object')
  if (typeof job.objective !== 'string' || !job.objective.trim()) throw new TypeError('computer job objective is required')
  if (!Array.isArray(job.permissions) || !job.permissions.length) throw new TypeError('computer job permissions are required')
  if (!job.limits || !Number.isInteger(job.limits.maxSteps) || job.limits.maxSteps < 1) throw new TypeError('computer job limits.maxSteps must be a positive integer')
  if (!job.limits || !Number.isInteger(job.limits.timeoutMs) || job.limits.timeoutMs < 1) throw new TypeError('computer job limits.timeoutMs must be a positive integer')
  return job
}

/**
 * Framework-neutral browser executor. It deliberately knows no sites, company
 * data, or model prompts. A planner supplies a bounded BrowserPlan; a driver
 * performs DOM/browser work; receipts expose an audit-safe event trail.
 */
export class ComputerOperator {
  constructor({ planner, driver, verifier, decisionEngine, visualFallback, receiptStore, clock = Date.now } = {}) {
    if (!planner?.compile) throw new TypeError('planner.compile(job) is required')
    if (!driver?.navigate || !driver?.observe || !driver?.click || !driver?.waitForStable) throw new TypeError('driver navigate/observe/click/waitForStable methods are required')
    if (!verifier?.check) throw new TypeError('verifier.check(plan, observation) is required')
    this.planner = planner
    this.driver = driver
    this.verifier = verifier
    this.decisionEngine = decisionEngine
    this.visualFallback = visualFallback
    this.receiptStore = receiptStore
    this.clock = clock
  }

  async run(input) {
    const job = validateJob({ ...input, limits: { ...DEFAULT_LIMITS, ...input?.limits } })
    const startedAt = this.clock()
    const jobId = input.id ?? `computer_job_${randomUUID()}`
    const record = event => this.#record({ job_id: jobId, at: nowIso(this.clock), ...event })
    await record({ type: 'job_started', objective: job.objective, permissions: job.permissions, limits: job.limits })

    const plan = await this.planner.compile(job)
    if (!plan?.startUrl) throw new TypeError('planner must return a bounded plan with startUrl')
    await record({ type: 'plan_compiled', start_url: plan.startUrl, completion_kind: plan.completion?.kind ?? null })
    await this.driver.navigate(plan.startUrl)

    const stateVisits = new Map()
    for (let step = 0; step < job.limits.maxSteps; step += 1) {
      if (this.clock() - startedAt > job.limits.timeoutMs) return this.#finish(record, { status: 'timed_out', steps: step })

      const observation = await this.driver.observe()
      const stateHash = observation.stateHash ?? hash({ url: observation.url, title: observation.title, candidates: observation.candidates })
      const visits = (stateVisits.get(stateHash) ?? 0) + 1
      stateVisits.set(stateHash, visits)
      await record({ type: 'observed', step, state_hash: stateHash, url: observation.url, candidate_count: observation.candidates?.length ?? 0 })

      const verified = await this.verifier.check(plan, observation)
      if (verified?.complete) return this.#finish(record, { status: 'completed', steps: step, result: verified.result ?? null, evidence: verified.evidence ?? [] })

      if (visits >= job.limits.maxRepeatedStates) {
        return this.#finish(record, { status: 'stuck', steps: step, reason: 'repeated_browser_state' })
      }

      let choice = await chooseCandidate({
        plan,
        candidates: observation.candidates ?? [],
        decisionEngine: this.decisionEngine,
        minimumConfidence: job.limits.minimumConfidence,
      })

      if (!choice && this.visualFallback?.choose) {
        choice = await this.visualFallback.choose({ job, plan, observation })
      }

      if (!choice?.candidate) {
        return this.#finish(record, { status: 'needs_human', steps: step, reason: 'no_safe_high_confidence_action' })
      }

      if (choice.requiresHuman || choice.candidate.requiresHuman) {
        return this.#finish(record, { status: 'needs_human', steps: step, reason: 'human_authority_required', candidate_id: choice.candidate.id })
      }

      await record({ type: 'action_selected', step, action: 'click', candidate_id: choice.candidate.id, confidence: choice.confidence, source: choice.source })
      await this.driver.click(choice.candidate)
      await this.driver.waitForStable()
      await record({ type: 'action_completed', step, action: 'click', candidate_id: choice.candidate.id })
    }

    return this.#finish(record, { status: 'step_limit_reached', steps: job.limits.maxSteps })
  }

  async #finish(record, result) {
    await record({ type: 'job_finished', ...result })
    return result
  }

  async #record(event) {
    if (this.receiptStore?.record) await this.receiptStore.record(event)
  }
}
