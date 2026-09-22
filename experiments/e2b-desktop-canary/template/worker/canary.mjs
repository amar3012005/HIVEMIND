import { ComputerOperator } from './operator/operator.mjs'
import { PlaywrightDriver } from './operator/playwright-driver.mjs'

const endpoint = process.env.HM_CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
console.log(JSON.stringify({ phase: 'worker_connect' }))
const driver = await PlaywrightDriver.connect(endpoint)

const operator = new ComputerOperator({
  planner: {
    compile: async () => ({
      startUrl: 'file:///home/user/hm-computer-worker/profile.html',
      target: { role: 'a', name: '18,402 Followers' },
      completion: { kind: 'fixture-followers' },
    }),
  },
  driver,
  verifier: {
    check: async (_plan, observation) => {
      if (observation.title !== 'Acme followers') return { complete: false }
      const text = await driver.page.locator('#follower-count').textContent()
      return {
        complete: true,
        result: { follower_count: Number(text.replaceAll(',', '')), source_url: driver.page.url() },
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
