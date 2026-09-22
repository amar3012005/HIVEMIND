import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerOperator, validateJob } from '../src/operator/operator.mjs'

function fixtureDriver() {
  const state = { page: 'profile', clicked: [], navigated: [] }
  return {
    state,
    navigate: async url => { state.navigated.push(url) },
    observe: async () => state.page === 'profile'
      ? {
          url: 'https://fixture.local/profile', title: 'Acme profile', stateHash: 'profile',
          candidates: [
            { id: 'following', role: 'link', name: 'Following', text: '243 Following' },
            { id: 'followers', role: 'link', name: 'Followers', text: '18,402 Followers' },
          ],
        }
      : { url: 'https://fixture.local/followers', title: 'Acme followers', stateHash: 'followers', candidates: [] },
    click: async candidate => { state.clicked.push(candidate.id); state.page = candidate.id === 'followers' ? 'followers' : state.page },
    waitForStable: async () => {},
  }
}

function job(overrides = {}) {
  return {
    objective: 'Open the profile and return the requested value.',
    permissions: ['read', 'navigate'],
    limits: { maxSteps: 4, timeoutMs: 5_000 },
    ...overrides,
  }
}

test('DOM-first operator completes a natural-language job with a bounded plan and no model decision', async () => {
  const driver = fixtureDriver()
  const receipts = []
  const operator = new ComputerOperator({
    planner: { compile: async input => {
      assert.match(input.objective, /requested value/)
      return { startUrl: 'https://fixture.local/profile', target: { role: 'link', name: 'Followers' }, completion: { kind: 'fixture-followers' } }
    } },
    driver,
    verifier: { check: async (_plan, observation) => observation.url.endsWith('/followers') ? { complete: true, result: { follower_count: 18402 } } : { complete: false } },
    receiptStore: { record: async receipt => receipts.push(receipt) },
  })

  const result = await operator.run(job())
  assert.deepEqual(result, { status: 'completed', steps: 1, result: { follower_count: 18402 }, evidence: [] })
  assert.deepEqual(driver.state.navigated, ['https://fixture.local/profile'])
  assert.deepEqual(driver.state.clicked, ['followers'])
  assert.equal(receipts.some(receipt => receipt.type === 'action_selected' && receipt.source === 'deterministic'), true)
})

test('operator uses a decision engine only after deterministic and rule selection cannot decide', async () => {
  const driver = fixtureDriver()
  const operator = new ComputerOperator({
    planner: { compile: async () => ({ startUrl: 'https://fixture.local/profile', hints: [], completion: { kind: 'fixture-followers' } }) },
    driver,
    verifier: { check: async (_plan, observation) => observation.url.endsWith('/followers') ? { complete: true } : { complete: false } },
    decisionEngine: { choose: async () => ({ candidateId: 'followers', confidence: 0.91, source: 'typed-decision' }) },
  })

  assert.equal((await operator.run(job())).status, 'completed')
  assert.deepEqual(driver.state.clicked, ['followers'])
})

test('operator pauses rather than acting where authority is required', async () => {
  const driver = fixtureDriver()
  const operator = new ComputerOperator({
    planner: { compile: async () => ({ startUrl: 'https://fixture.local/profile' }) },
    driver,
    verifier: { check: async () => ({ complete: false }) },
    decisionEngine: { choose: async () => ({ candidateId: 'followers', confidence: 1, requiresHuman: true }) },
  })

  const result = await operator.run(job())
  assert.equal(result.status, 'needs_human')
  assert.equal(driver.state.clicked.length, 0)
})

test('job validation rejects unbounded work before a browser is acquired', () => {
  assert.throws(() => validateJob({ objective: 'x', permissions: ['read'], limits: { maxSteps: 0, timeoutMs: 1 } }), /maxSteps/)
  assert.throws(() => validateJob({ objective: 'x', permissions: [], limits: { maxSteps: 1, timeoutMs: 1 } }), /permissions/)
})
