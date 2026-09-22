import { ComputerOperator } from './operator/operator.mjs'
import { createJevDecisionEngine } from './operator/jev-decision.mjs'
import { PlaywrightDriver } from './operator/playwright-driver.mjs'

const endpoint = process.env.HM_CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const trace = []
let decisionCalls = 0

const configuredDecisionEngine = createJevDecisionEngine({
  decisionsUrl: process.env.HM_JEV_DECISIONS_URL ?? 'https://openrouter.ai/api/alpha/decisions',
  apiKey: process.env.HM_JEV_API_KEY,
  httpReferer: 'https://next.singulancelabs.com',
  title: 'HIVE-MIND public Jev canary',
})
const decisionEngine = {
  choose: async input => {
    decisionCalls += 1
    return configuredDecisionEngine.choose(input)
  },
}

console.log(JSON.stringify({ phase: 'worker_connect', mode: 'public-read-only' }))
const driver = await PlaywrightDriver.connect(endpoint)

const operator = new ComputerOperator({
  planner: {
    compile: async () => ({
      startUrl: 'https://example.com/',
      // No exact target or local hints: Jev must make the bounded selection
      // from the current observed DOM table before the link can be clicked.
      decisionInstruction: 'Open the observed Learn more link on Example Domain. Do not submit data or perform any write action.',
      completion: { kind: 'public-example-domain-fact' },
    }),
  },
  driver,
  decisionEngine,
  receiptStore: {
    record: async event => {
      const allowed = {
        type: event.type,
        step: event.step ?? null,
        action: event.action ?? null,
        candidate_id: event.candidate_id ?? null,
        source: event.source ?? null,
        confidence: Number.isFinite(event.confidence) ? event.confidence : null,
        url: event.url ?? null,
        candidate_count: Number.isInteger(event.candidate_count) ? event.candidate_count : null,
      }
      trace.push(allowed)
    },
  },
  verifier: {
    check: async (_plan, observation) => {
      const current = new URL(observation.url)
      if (!/iana\.org$/i.test(current.hostname)) return { complete: false }
      const heading = String(await driver.page.locator('h1').first().textContent() ?? '').trim()
      if (heading !== 'Example Domains') return { complete: false }

      // The browser DOM is the visible observation. Fetching the canonical
      // public IANA document separately is an independent transport check of
      // the same fact; no credential, form, or mutation is involved.
      const response = await fetch('https://www.iana.org/domains/example', {
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      })
      const document = await response.text()
      const independentHttpVerified = response.ok && /<h1[^>]*>\s*Example Domains\s*<\/h1>/i.test(document)
      if (!independentHttpVerified) return { complete: false }

      return {
        complete: true,
        result: {
          fact: { label: 'visible_heading', value: heading },
          source_url: observation.url,
          verification: { browser_visible: true, independent_http: true },
          decision: { provider: 'openrouter-jev', calls: decisionCalls },
          trace,
        },
      }
    },
  },
})

const result = await operator.run({
  objective: 'Read the public Example Domains fact through a bounded browser decision loop.',
  permissions: ['read', 'navigate'],
  limits: { maxSteps: 3, timeoutMs: 45_000, minimumConfidence: 0.6 },
})
if (result.status !== 'completed') throw new Error(`Public Jev canary did not complete: ${result.status}`)
console.log(JSON.stringify({ phase: 'worker_completed', decision_calls: decisionCalls }))
await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve))
process.exit(0)
