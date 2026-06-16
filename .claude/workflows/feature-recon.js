export const meta = {
  name: 'feature-recon',
  description: 'Does this feature already exist? Parallel graph + git + HIVEMIND-memory recon → reuse/extend/build verdict.',
  whenToUse: 'Run BEFORE building any feature/endpoint/module. Pass args = the feature description (string). Returns a verdict block (exists | partial | missing) with evidence so you reuse instead of rebuild — the #1 token/time waste in this repo.',
  phases: [{ title: 'Recon' }, { title: 'Verdict' }],
}

const feature = typeof args === 'string' ? args : (args?.feature || args?.query || (args ? JSON.stringify(args) : ''))
if (!feature || !String(feature).trim()) {
  log('No feature given. Invoke with args = "the feature description".')
  return { error: 'no feature description in args' }
}

const FINDING = {
  type: 'object',
  additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['exists', 'partial', 'missing', 'unknown'] },
    evidence: { type: 'string', description: 'graph node names / commit SHAs / file:line ACTUALLY found' },
    wired: { type: 'string', description: 'live (callers: …) | dead/stub | branch-only | n/a' },
    reuse_or_gap: { type: 'string', description: 'what to call/extend, OR the exact delta to build' },
  },
  required: ['status', 'evidence'],
}

phase('Recon')
const lanes = [
  {
    lane: 'graph',
    prompt: `Repo: /Users/amar/HIVE-MIND. Using ONLY the code-review-graph MCP tools (semantic_search_nodes, query_graph callers_of/callees_of/tests_for, get_architecture_overview), decide whether this ALREADY exists: "${feature}". Try 2-3 phrasings (verb+noun). For promising hits, check callers (wired vs dead) and tests_for (mature vs stub). Do NOT read whole files; at most ONE targeted grep to confirm a specific symbol. Report status, the exact node names, wired?, and what to reuse/extend OR the gap.`,
  },
  {
    lane: 'git',
    prompt: `Repo: /Users/amar/HIVE-MIND. Using git ONLY: \`git log --oneline --grep "<kw>" -i\`, \`git log -S "<symbol>" --oneline\` (pickaxe), \`git log --oneline --all --grep "<kw>"\` (catch unmerged branches). Decide whether "${feature}" was ever built / renamed / reverted / lives on a branch. Report status + commit SHAs + what each did. This catches history the current-state graph cannot.`,
  },
  {
    lane: 'memory',
    prompt: `Use the HIVEMIND MCP tools (hivemind_recall with 2-3 broad queries, hivemind_recall_bugs) to find prior decisions, prior implementations, or known gotchas about: "${feature}". Report what HIVEMIND already knows (memory titles + gist) and any gotcha/bug to avoid. If nothing relevant, say so explicitly.`,
  },
]
const findings = await parallel(lanes.map((l) => () =>
  agent(l.prompt, { label: `recon:${l.lane}`, phase: 'Recon', schema: FINDING })
    .then((r) => (r ? { lane: l.lane, ...r } : null)),
)).then((rs) => rs.filter(Boolean))

phase('Verdict')
const verdict = await agent(
  `Synthesize ONE recon verdict for the feature "${feature}" from these lane findings:\n${JSON.stringify(findings, null, 2)}\n\n`
  + `Output the verdict block — overall STATUS (exists | partial | missing), EVIDENCE (concrete graph nodes / commit SHAs / file:line), WIRED, and REUSE (what to call/extend) OR GAP (the exact delta to build). `
  + `Rule: "missing" in the graph + a hit in git = removed or branch-only — say that, do NOT declare greenfield. Keep it to the verdict block; spend output on the answer, not narration.`,
  { label: 'verdict', phase: 'Verdict' },
)

log('Recon complete.')
return { feature, lanes: findings, verdict }
