export const meta = {
  name: 'review-changes',
  description: 'Adversarial multi-dimension review of the current git diff before commit — bugs, security/tenant-isolation, perf, db/migration, standards. Each finding is skeptic-verified against the diff.',
  whenToUse: 'Run after writing code, before commit/deploy. Reviews `git diff HEAD` (staged+unstaged) in /Users/amar/HIVE-MIND. Returns only verified findings so you fix real issues, not noise.',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

// Dimensions are tuned to the failure classes that actually recur in HIVEMIND.
const DIMENSIONS = [
  { key: 'bugs', prompt: 'correctness bugs, null/undefined deref, async/await mistakes + floating promises, missing error handling, off-by-one / edge cases, TDZ / self-reference (a replace_all once turned an object literal into ...self — burned a deploy)' },
  { key: 'security', prompt: 'TENANT ISOLATION (every query scoped by org_id/user_id — the recurring leak class), authz on endpoints, injection, secrets/keys hardcoded in source, scope leaks (guest/project visibility), never the master key when emulating a user' },
  { key: 'perf', prompt: 'N+1 queries, Promise.all pool contention (the vectorCandidates 150→1 getMemory class — batch instead), unbounded loops, missing LIMIT/caps, blocking LLM calls added to a hot/recall path' },
  { key: 'db', prompt: 'Prisma/SQL: backward-compatible migration WITH a down path, tenant scoping on new queries, raw-SQL column drift (memories table has NO json `metadata` column — parent→children is via the relationships PartOf edge, not metadata->>parent_memory_id), no SELECT *' },
  { key: 'standards', prompt: 'explicit types/hints, no console.log in prod paths, no eslint-disable/@ts-ignore without a reason comment, ESM (repo is type:module), reads like the surrounding code, no dead code/unused imports' },
]

const FINDINGS = {
  type: 'object', additionalProperties: true,
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: true,
    properties: {
      title: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      detail: { type: 'string' }, fix: { type: 'string' },
    }, required: ['title', 'file', 'severity', 'detail'],
  } } }, required: ['findings'],
}
const VERDICT = { type: 'object', additionalProperties: true, properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }

phase('Review')
// Pipeline: each dimension's findings verify the instant that dimension finishes
// (no barrier) — security findings get refuted while perf is still reading.
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(
    `Repo /Users/amar/HIVE-MIND. Run \`git diff HEAD\` (staged+unstaged). Review ONLY the changed lines for: ${d.prompt}. Concrete findings with file:line from the diff. If clean, return {findings: []}.`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS },
  ),
  (rev, d) => parallel((rev?.findings || []).map((f) => () =>
    agent(
      `Adversarially verify this ${d.key} finding against the ACTUAL diff (git diff HEAD) in /Users/amar/HIVE-MIND — try to REFUTE it. It is only real if it is in the CHANGED lines and would actually bite. Default real=false when uncertain.\nFinding: ${JSON.stringify(f)}`,
      { label: `verify:${f.file || d.key}`, phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ ...f, dimension: d.key, verdict: v })),
  )),
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict?.real)
  .sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a.severity] - { critical: 0, high: 1, medium: 2, low: 3 }[b.severity]))
log(`${confirmed.length} confirmed of ${all.length} raw finding(s).`)
return { confirmed, raw_count: all.length }
