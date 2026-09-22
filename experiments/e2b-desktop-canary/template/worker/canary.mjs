import { ComputerOperator } from './operator/operator.mjs'
import { createJevDecisionEngine } from './operator/jev-decision.mjs'
import { PlaywrightDriver } from './operator/playwright-driver.mjs'

const endpoint = process.env.HM_CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const useJev = process.env.HM_JEV_CANARY === '1'
let decisionCalls = 0
const configuredDecisionEngine = useJev
  ? createJevDecisionEngine({
      decisionsUrl: process.env.HM_JEV_DECISIONS_URL,
      gatewayToken: process.env.HM_JEV_GATEWAY_TOKEN,
      byokAlias: process.env.HM_JEV_BYOK_ALIAS,
      providerApiKey: process.env.HM_JEV_PROVIDER_API_KEY,
      model: process.env.HM_JEV_MODEL,
    })
  : null
const decisionEngine = configuredDecisionEngine
  ? { choose: async input => {
      decisionCalls += 1
      return configuredDecisionEngine.choose(input)
    } }
  : null
console.log(JSON.stringify({ phase: 'worker_connect' }))
const driver = await PlaywrightDriver.connect(endpoint)

const operator = new ComputerOperator({
  planner: {
    compile: async () => ({
      startUrl: 'file:///home/user/hm-computer-worker/profile.html',
      // The deterministic canary proves DOM control without model latency. The
      // Jev canary deliberately leaves the target unresolved, so a live typed
      // decision is used only after exact/rule matching cannot choose.
      ...(useJev ? {
        decisionInstruction: 'Open the observed Followers entry, not Following, so the current follower count can be returned.',
      } : { target: { role: 'a', name: '18,402 Followers' } }),
      completion: { kind: 'fixture-followers' },
    }),
  },
  driver,
  decisionEngine,
  verifier: {
    check: async (_plan, observation) => {
      if (observation.title !== 'Acme followers') return { complete: false }
      const text = await driver.page.locator('#follower-count').textContent()
      return {
        complete: true,
        result: {
          follower_count: Number(text.replaceAll(',', '')),
          source_url: driver.page.url(),
          decision: useJev ? { provider: 'cloudflare-custom-openrouter', calls: decisionCalls } : { provider: 'deterministic', calls: 0 },
        },
      }
    },
  },
})

const result = await operator.run({
  objective: 'Open the profile and return the requested value.',
  permissions: ['read', 'navigate'],
  limits: { maxSteps: 4, timeoutMs: 60_000 },
})
if (result.status !== 'completed') throw new Error(`DOM operator fixture did not complete: ${result.status}`)
console.log(JSON.stringify({ phase: 'worker_completed' }))
await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve))

// This worker is attached to a user-visible, long-lived Chrome process. Let
// process exit release the CDP connection instead of closing the shared browser
// so a human can take over the desktop after the agent stops.
process.exit(0)
