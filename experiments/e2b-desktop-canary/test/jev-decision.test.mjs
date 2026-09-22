import assert from 'node:assert/strict'
import test from 'node:test'
import { createJevDecisionEngine } from '../src/operator/jev-decision.mjs'

const candidates = [
  { id: 'following', role: 'link', name: '243 Following', text: '243 Following' },
  { id: 'followers', role: 'link', name: '18,402 Followers', text: '18,402 Followers' },
]

test('Jev decision adapter uses the configured Cloudflare custom-provider decision endpoint', async () => {
  const calls = []
  const engine = createJevDecisionEngine({
    decisionsUrl: 'https://gateway.example/v1/account/gateway/openrouter/api/alpha/decisions',
    gatewayToken: 'gateway-secret',
    byokAlias: 'openrouter-production',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        answers: { target: { choice: 'followers', probabilities: { following: 0.02, followers: 0.98 } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const decision = await engine.choose({ plan: { decisionInstruction: 'Open followers.' }, candidates })
  assert.deepEqual(decision, { candidateId: 'followers', confidence: 0.98, source: 'cloudflare-custom-openrouter-jev' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gateway.example/v1/account/gateway/openrouter/api/alpha/decisions')
  assert.equal(calls[0].init.headers['cf-aig-authorization'], 'Bearer gateway-secret')
  assert.equal(calls[0].init.headers['cf-aig-byok-alias'], 'openrouter-production')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.decisionsRequest.model, '~typesafe/jev-latest')
  assert.deepEqual(Object.keys(body.decisionsRequest.questions.target.criteria), ['following', 'followers'])
})

test('Jev adapter does not disclose provider errors or credentials', async () => {
  const engine = createJevDecisionEngine({
    decisionsUrl: 'https://gateway.example/decisions',
    gatewayToken: 'never-disclose-this',
    byokAlias: 'openrouter-production',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'upstream failure' } }), { status: 401 }),
  })
  await assert.rejects(() => engine.choose({ plan: {}, candidates }), error => {
    assert.match(error.message, /HTTP 401/)
    assert.doesNotMatch(error.message, /never-disclose-this|upstream failure/)
    return true
  })
})
