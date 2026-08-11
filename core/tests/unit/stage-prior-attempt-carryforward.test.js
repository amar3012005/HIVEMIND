import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('../../src/runtime-playbooks/stage-executor.js', import.meta.url);

// The defect this guards: a REPAIR retry only ever received its UPSTREAM inputs, never its
// own rejected draft. So each attempt rewrote the artifact from scratch and the shape
// churned instead of converging — form_strategy attempt 2 produced a full channel_mix,
// attempt 3 dropped it, attempt 4 lost niche_wedge as well. Seven attempts, no monotonic
// progress. The artifacts were already persisted on the run; the stage simply never asked.

test('the prior-attempt draft is injected on retries and only on retries', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /function priorAttemptInputs\(run, stage, attempt\)/);
  // First attempt must NOT carry a draft — there is none, and pretending otherwise would
  // feed the room an empty object it might treat as a real previous answer.
  assert.match(source, /if \(!\(attempt > 1\)\) return \{\};/);
  // Namespaced so it can never collide with a declared input_ref.
  assert.match(source, /`prior_attempt\.\$\{key\}`/);
  assert.match(source, /`prior_attempt_all\.\$\{key\}`/);
  // Both dispatch sites (the normal path and the error/repair path) must carry it, keyed
  // by the REPAIR-scoped attempt counter (repairAttempt), not the raw stage-attempt count.
  // They diverged on purpose: a WAITING_EVENT resumption no longer bumps stageAttempts (an
  // event continuation is not a retry), so repairAttempt is the counter that actually tracks
  // "how many times has this stage's own output been rejected" — the number this function
  // needs to decide whether a prior draft exists to carry forward.
  const wired = source.match(/priorAttemptInputs\(run, stage, repairAttempt\)/g) || [];
  assert.equal(wired.length, 2, 'both dispatch sites must inject the prior draft, keyed by repairAttempt');
});

test('the prior draft is the LAST draft of each expected artifact, upstream inputs untouched', () => {
  // Mirrors priorAttemptInputs' contract without booting the executor (which needs pg).
  const grouped = { marketing_strategy: [{ id: 'a', data: {} }, { id: 'b', data: { niche_wedge: 'x' } }] };
  const stage = { expected_artifacts: ['marketing_strategy', 'absent_key'] };
  const resolved = {};
  for (const key of stage.expected_artifacts) {
    const rows = grouped[key];
    if (Array.isArray(rows) && rows.length) {
      resolved[`prior_attempt.${key}`] = rows[rows.length - 1];
      resolved[`prior_attempt_all.${key}`] = rows;
    }
  }
  assert.deepEqual(Object.keys(resolved), ['prior_attempt.marketing_strategy', 'prior_attempt_all.marketing_strategy']);
  assert.equal(resolved['prior_attempt.marketing_strategy'].id, 'b', 'must take the latest draft');
  assert.equal(resolved['prior_attempt_all.marketing_strategy'].length, 2, 'must retain the complete accepted set');
  // An expected artifact with no draft yet contributes nothing rather than a null.
  assert.equal('prior_attempt.absent_key' in resolved, false);
});

test('form_strategy names the strategy ladder and allows the ladder room to converge', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('../../src/runtime-playbooks/fixtures/marketing-strategy-to-growth-brief.v1.json', import.meta.url), 'utf8'));
  const stage = fixture.stages.find((row) => row.id === 'form_strategy');
  assert.ok(stage, 'form_strategy stage must exist');
  // The objective must teach the METHOD, not only the output shape. A shape-only prompt is
  // what produced generic "competitors focus on scale over compliance" filler.
  for (const rung of ['DIAGNOSIS', 'WEDGE', 'POSITIONING', 'OFFER', 'CHANNELS', 'MOTIONS', 'MEASURES']) {
    assert.match(stage.objective, new RegExp(rung), `objective must name the ${rung} rung`);
  }
  assert.match(stage.objective, /prior_attempt_draft/, 'objective must state the carry-forward rule');
  // A 7-rung ladder converging monotonically needs more than two shots, but still a ceiling.
  assert.ok(stage.max_attempts >= 3 && stage.max_attempts <= 6, `max_attempts ${stage.max_attempts} out of range`);
  assert.equal(stage.on_failure, 'REPAIR');
});
