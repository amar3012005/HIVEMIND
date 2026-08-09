import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../src/', import.meta.url);

test('production HQ modules have one lifecycle authority and do not wire legacy LangGraph services', () => {
  const production = [
    'hq-runtime/scheduler.js',
    'hq-runtime/routes.js',
    'hq-runtime/native-engine.js',
    'control-plane-server.js',
  ];
  const violations = [];
  for (const file of production) {
    const source = readFileSync(new URL(file, ROOT), 'utf8');
    if (/emailLifecycle|hq-runtime\/langgraph|langgraph\/email-lifecycle/.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, [], `production modules still wire a competing lifecycle: ${violations.join(', ')}`);
});

test('every declared provider delivery or launch stage has an exact immutable authority gate', () => {
  const directory = new URL('../../src/runtime-playbooks/fixtures/', import.meta.url);
  const violations = [];
  let externalStages = 0;
  const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json')).map((file) => ({
    file, playbook: JSON.parse(readFileSync(new URL(file, directory), 'utf8')),
  }));
  const latest = new Map();
  for (const fixture of fixtures) {
    const current = latest.get(fixture.playbook.playbook_id);
    if (!current || fixture.playbook.version > current.playbook.version) latest.set(fixture.playbook.playbook_id, fixture);
  }
  // Historical versions are immutable and remain loadable for existing runs. New
  // selection exposes only each lifecycle's latest active version, so that is the
  // authority surface that must satisfy the modern exact-input binding invariant.
  for (const { file, playbook } of latest.values()) {
    for (const stage of playbook.stages || []) {
      const action = String(stage.execution?.config?.action || '');
      if (!['deliver', 'launch'].includes(action)) continue;
      externalStages += 1;
      if (!stage.authority_gate || !stage.authority_policy_key || stage.authority_binding !== 'stage_inputs') {
        violations.push(`${file}:${stage.id}`);
      }
    }
  }
  assert.ok(externalStages >= 5, `expected broad external-effect coverage, saw ${externalStages}`);
  assert.deepEqual(violations, [], `external stages without exact authority: ${violations.join(', ')}`);
});
