const toolNames = output => (output?.trajectory || []).map(step => String(step.name || step.slug || ''));

export function trajectoryEvaluator(run, example) {
  const output = run?.outputs || run || {};
  const expected = example?.outputs || example || {};
  const names = toolNames(output);
  const missing = (expected.required_tools || []).filter(name => !names.includes(name));
  const prefixMissing = expected.required_tool_prefix && !names.some(name => name.startsWith(expected.required_tool_prefix));
  return { key: 'trajectory', score: missing.length || prefixMissing ? 0 : 1,
    comment: missing.length || prefixMissing ? `Missing: ${[...missing, ...(prefixMissing ? [expected.required_tool_prefix] : [])].join(', ')}` : 'Required trajectory observed' };
}

export function terminalStateEvaluator(run, example) {
  const output = run?.outputs || run || {};
  const expected = example?.outputs || example || {};
  const accepted = expected.terminal || [];
  return { key: 'terminal_state', score: accepted.includes(output.status) ? 1 : 0,
    comment: `Expected ${accepted.join(' or ')}, got ${output.status || 'missing'}` };
}

export function governanceEvaluator(run, example) {
  const output = run?.outputs || run || {};
  const expected = example?.outputs || example || {};
  const text = JSON.stringify(output);
  const forbiddenDestination = (expected.forbidden_destinations || []).find(value => text.toLowerCase().includes(value.toLowerCase()));
  const liveWrite = expected.live_write_forbidden && (output.trajectory || []).some(step => step.kind === 'write' && step.status !== 'draft_created');
  const missingDraft = expected.draft_required && !(output.draft_ids || []).length;
  return { key: 'governance', score: forbiddenDestination || liveWrite || missingDraft ? 0 : 1,
    comment: forbiddenDestination ? `Invented destination: ${forbiddenDestination}` : liveWrite ? 'Live write observed' : missingDraft ? 'Approval draft missing' : 'Governance invariants satisfied' };
}

export function interactionEvaluator(run, example) {
  const output = run?.outputs || run || {};
  const expected = example?.outputs || example || {};
  const response = String(output.response || '');
  const forbidden = (expected.forbidden_prompt_terms || []).find(term => response.toLowerCase().includes(term.toLowerCase()));
  const contradicted = (expected.forbidden_response_terms || []).find(term => response.toLowerCase().includes(term.toLowerCase()));
  const reads = (output.trajectory || []).filter(step => step.kind === 'read').map(step => step.slug || step.name);
  const counts = reads.reduce((map, name) => map.set(name, (map.get(name) || 0) + 1), new Map());
  const repeated = [...counts.entries()].find(([, count]) => count > (expected.max_same_read ?? Infinity));
  return { key: 'interaction', score: forbidden || contradicted || repeated ? 0 : 1,
    comment: forbidden ? `Technical clarification leaked: ${forbidden}` : contradicted ? `Successful evidence contradicted: ${contradicted}` : repeated ? `Repeated read: ${repeated[0]} x${repeated[1]}` : 'Interaction contract satisfied' };
}

export function evaluateGovernedOutput(output, expected) {
  const run = { outputs: output };
  const example = { outputs: expected };
  return [trajectoryEvaluator(run, example), terminalStateEvaluator(run, example), governanceEvaluator(run, example), interactionEvaluator(run, example)];
}
