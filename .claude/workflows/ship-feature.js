export const meta = {
  name: 'ship-feature',
  description: 'Autonomous end-to-end feature build for HIVEMIND: triage→recon→design(+threat)→plan→TDD-RED→implement→adversarial-review↻→local-E2E, writing a durable .pipeline/<slug>/ artifact bus. PARKS at the human ship-gate — never commits to main or deploys (main IS prod here). The /ship-feature command does the gate + ship.',
  whenToUse: 'Invoke with args = the feature/intent string (e.g. "rate-limit the login endpoint"). Reuses feature-recon + review-changes (as sub-workflows) and the agent roster (architect/planner/tdd-writer/implementer/threat-modeler/e2e-runner). Tier-gates depth (TRIVIAL/STANDARD/RISK) so a doc tweak is cheap and an auth/migration/recall change gets the full adversarial chain. Returns a ship dossier for the human gate.',
  phases: [
    { title: 'Triage' }, { title: 'Recon' }, { title: 'Design' }, { title: 'Plan' },
    { title: 'TDD-RED' }, { title: 'Implement' }, { title: 'Review' }, { title: 'E2E' }, { title: 'Dossier' },
  ],
}

const REPO = '/Users/amar/HIVE-MIND'
const intent = typeof args === 'string' ? args : (args?.feature || args?.intent || (args ? JSON.stringify(args) : ''))
if (!intent || !String(intent).trim()) {
  log('No feature given. Invoke with args = "the feature/intent description".')
  return { error: 'no intent in args' }
}

// ---- schemas (machine hand-off between stages; agents ALSO write the .md/.json files) ----
const TRIAGE = {
  type: 'object', additionalProperties: true,
  properties: {
    slug: { type: 'string', description: 'kebab-case of the intent' },
    tier: { type: 'string', enum: ['TRIVIAL', 'STANDARD', 'RISK'] },
    touched_files: { type: 'array', items: { type: 'string' } },
    blast_radius: { type: 'string' },
    surfaces: {
      type: 'object', additionalProperties: true,
      properties: { security: { type: 'boolean' }, db: { type: 'boolean' }, fe: { type: 'boolean' }, infra: { type: 'boolean' }, recall: { type: 'boolean' } },
    },
    reason: { type: 'string' },
  },
  required: ['slug', 'tier', 'surfaces'],
}
const DESIGN = {
  type: 'object', additionalProperties: true,
  properties: {
    reuse_honored: { type: 'boolean' }, schema_delta: { type: 'string' }, migration_shape: { type: 'string' },
    unmitigatable_threat: { type: 'boolean' }, threats: { type: 'array', items: { type: 'string' } },
    required_tests: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['summary'],
}
const PLAN = {
  type: 'object', additionalProperties: true,
  properties: {
    tasks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
      id: { type: 'string' }, summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
      deps: { type: 'array', items: { type: 'string' } }, parallel_safe: { type: 'boolean' }, owner_agent: { type: 'string' },
    }, required: ['id', 'summary', 'owner_agent'] } },
    critical_path: { type: 'array', items: { type: 'string' } },
    down_migration: { type: 'string' },
  },
  required: ['tasks'],
}
const RED = { type: 'object', additionalProperties: true, properties: { red_confirmed: { type: 'boolean' }, test_files: { type: 'array', items: { type: 'string' } }, failing_count: { type: 'number' }, notes: { type: 'string' } }, required: ['red_confirmed'] }
const IMPL = { type: 'object', additionalProperties: true, properties: { green: { type: 'boolean' }, files_changed: { type: 'array', items: { type: 'string' } }, node_check_clean: { type: 'boolean' }, blockers: { type: 'array', items: { type: 'string' } }, author_agent: { type: 'string' } }, required: ['green'] }
const E2E = { type: 'object', additionalProperties: true, properties: { pass: { type: 'boolean' }, flows_run: { type: 'array', items: { type: 'string' } }, perf_findings: { type: 'array', items: { type: 'string' } }, regressed: { type: 'boolean' } }, required: ['pass'] }

// kebab fallback slug (stage-0 agent confirms/overrides in TRIAGE.slug)
const seedSlug = String(intent).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'feature'
const PIPE = (slug) => `.pipeline/${slug}`
// shared boilerplate so every stage writes its artifact + advances the manifest cursor
const scribe = (slug, file, stageKey) => `After finishing, write your structured result as JSON to ${REPO}/${PIPE(slug)}/${file} (create the dir if needed), and update ${REPO}/${PIPE(slug)}/manifest.json so .current_stage="${stageKey}" and .stage_status["${stageKey}"]="pass" (create manifest.json as {slug:"${slug}",intent:${JSON.stringify(intent)},author:"amarsai3012005",current_stage:"${stageKey}",status:"running",stage_status:{}} if absent). Do NOT git add/commit.`

const halt = (slug, reason, extra = {}) => {
  log(`HALT (awaiting human): ${reason}`)
  return { status: 'halted_awaiting_human', slug, intent, halt_reason: reason, manifest: `${PIPE(slug)}/manifest.json`, ...extra }
}

// ============================ STAGE 0 — TRIAGE & TIER ============================
phase('Triage')
const triage = await agent(
  `Repo: ${REPO}. Classify this change for a tiered ship pipeline. Intent: "${intent}".\n`
  + `Use the code-review-graph MCP (get_impact_radius / get_affected_flows / semantic_search_nodes) for ONE cheap blast-radius probe on the likely touched area, plus \`git diff HEAD\` if a change is already in progress. Decide:\n`
  + `- slug: kebab-case of the intent.\n`
  + `- tier: TRIVIAL (doc/copy/const, zero risk surface) | STANDARD (≤~3 files, no auth/db-migration/recall) | RISK (auth, OAuth/Nango, Prisma migration, tenant-scope, payments, deploy/infra, OR the recall path).\n`
  + `- surfaces: booleans for security, db, fe, infra, recall.\n`
  + `RULE: if ANY of security|db|infra|recall is true it is at least STANDARD, never TRIVIAL. When unsure, fail UP to the higher tier. Create ${REPO}/${PIPE(seedSlug)}/ as the working dir but use YOUR slug in the artifact path if you rename it.\n`
  + scribe('${SLUG}', '00-triage.json', '00').replace('${SLUG}', seedSlug),
  { label: 'triage', phase: 'Triage', model: 'haiku', agentType: 'cartographer', schema: TRIAGE },
)
if (!triage) return halt(seedSlug, 'triage agent returned nothing')
const slug = (triage.slug || seedSlug).replace(/[^a-z0-9-]/g, '') || seedSlug
const tier = triage.tier || 'STANDARD'
const surf = triage.surfaces || {}
const adversarial = tier === 'RISK' || surf.security || surf.recall || surf.infra
log(`tier=${tier} · surfaces=${Object.entries(surf).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'} · slug=${slug}`)

// ============================ STAGE 1 — RECON (blocking) ============================
const RECON_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    status: { type: 'string', enum: ['exists', 'partial', 'missing'] },
    evidence: { type: 'array', items: { type: 'string' } },
    wired: { type: 'string' },
    reuse_or_gap: { type: 'string' },
  },
  required: ['status'],
}
let recon = null
if (tier !== 'TRIVIAL') {
  phase('Recon')
  recon = await agent(
    `Repo: ${REPO}. Feature recon for: "${intent}". Answer: does this already exist, fully or partially?\n`
    + `1. code-review-graph MCP first: semantic_search_nodes with 2–3 phrasings (verb+noun). For each promising hit: query_graph callers_of to check wired-live vs dead stub.\n`
    + `2. git log --oneline --grep "..." -i + git log -S "<key symbol>" --oneline — check branches too.\n`
    + `3. hivemind_recall({ tags: [], mode: "panorama", limit: 10 }) to surface any prior-session build of this feature.\n`
    + `4. Targeted grep ONLY to confirm a specific graph/git hit.\n`
    + `Return status: "exists"|"partial"|"missing", evidence[], wired (callers or "no"), reuse_or_gap. ${scribe(slug, '01-recon.json', '01')}`,
    { label: 'recon', phase: 'Recon', model: 'sonnet', agentType: 'cartographer', schema: RECON_SCHEMA },
  ).catch((e) => { log(`recon agent failed: ${e.message}`); return null })
  // GATE A — already shipped & wired-live → do not rebuild
  const wiredLive = recon && /live/i.test(JSON.stringify(recon.wired || ''))
  if (recon && /^exists$/i.test(recon.status || '') && wiredLive) {
    return halt(slug, `recon: ALREADY EXISTS and wired-live — reuse/extend instead of rebuild. Evidence: ${JSON.stringify(recon.evidence || []).slice(0, 400)}`, { recon })
  }
}

// ============================ STAGE 2 — DESIGN (+ conditional threat model) ============================
let design = null, threats = null
if (tier !== 'TRIVIAL') {
  phase('Design')
  const designP = agent(
    `Repo: ${REPO}. Design the implementation for: "${intent}".\n`
    + `Recon verdict (you MUST honor its reuse target or explicitly justify net-new): ${JSON.stringify(recon || 'n/a').slice(0, 800)}\n`
    + `Produce interfaces, module boundaries, the schema delta, and the UP+DOWN migration shape if the DB is touched. Keep it surgical (this repo's server.js is a 20k-line monolith — extend, don't rewrite). Write the human-readable design to ${REPO}/${PIPE(slug)}/02-design.md AND log the decision via hivemind_log_decision. ${scribe(slug, '02-design.json', '02')}`,
    { label: 'design', phase: 'Design', model: 'opus', agentType: 'architect', schema: DESIGN },
  )
  const threatP = adversarial
    ? agent(
        `Repo: ${REPO}. Threat-model the change: "${intent}" (surfaces: ${JSON.stringify(surf)}). Enumerate attack paths and the TENANT-ISOLATION surface (every new query must be scoped by org_id/user_id — the recurring leak class here). Output required_tests[] that the TDD stage MUST cover (include a two-tenant isolation case: seed org A + org B, assert A never returns B's rows). Flag unmitigatable_threat:true only if there is no safe design. Write to ${REPO}/${PIPE(slug)}/02-threats.json.`,
        { label: 'threat-model', phase: 'Design', model: 'opus', agentType: 'threat-modeler', schema: DESIGN },
      )
    : Promise.resolve(null)
  ;[design, threats] = await Promise.all([designP, threatP])
  if ((design && design.unmitigatable_threat) || (threats && threats.unmitigatable_threat)) {
    return halt(slug, 'design/threat-model found an UNMITIGATABLE threat — needs a human decision before any code', { design, threats })
  }
}
const requiredTests = [...(design?.required_tests || []), ...(threats?.required_tests || []), ...(threats?.threats || [])].filter(Boolean)

// ============================ STAGE 3 — PLAN (atomic DAG) ============================
let plan = null
if (tier !== 'TRIVIAL') {
  phase('Plan')
  plan = await agent(
    `Repo: ${REPO}. Decompose this design into an atomic, ordered task DAG for: "${intent}".\n`
    + `Design: ${JSON.stringify(design || {}).slice(0, 1200)}\n`
    + `Each task ≤1 logical change: {id, summary, files[], deps[], parallel_safe, owner_agent (implementer-backend|implementer-frontend|implementer-infra|tdd-writer)}. CRITICAL: any task editing core/src/server.js must be on the critical_path and NOT parallel_safe (serialize edits to the monolith). Every DB task carries an up AND down migration. ${scribe(slug, '03-plan.json', '03')}`,
    { label: 'plan', phase: 'Plan', model: 'sonnet', agentType: 'planner', schema: PLAN },
  )
}
const tasks = plan?.tasks?.length ? plan.tasks : [{ id: 'T1', summary: intent, files: triage.touched_files || [], deps: [], parallel_safe: false, owner_agent: surf.fe ? 'implementer-frontend' : 'implementer-backend' }]

// ============================ STAGE 4 — TDD RED (tests before code) ============================
if (tier !== 'TRIVIAL') {
  phase('TDD-RED')
  let red = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    red = await agent(
      `Repo: ${REPO}. Write FAILING tests (RED) BEFORE implementation for: "${intent}".\n`
      + `Plan tasks: ${JSON.stringify(tasks).slice(0, 1000)}\n`
      + `MANDATORY coverage (required by design/threat-model): ${JSON.stringify(requiredTests).slice(0, 800) || 'happy + boundary + failure + security edge'}.\n`
      + `Cover happy path, boundary, failure mode, and — whenever a tenant-scoped query is touched — a two-tenant isolation test. RUN the tests and capture output: every new test MUST FAIL for the RIGHT reason (not import/syntax error, not empty). Put test files under ${REPO}/${PIPE(slug)}/04-tests/ or the repo's test dir. ${scribe(slug, '04-red-report.json', '04')}`,
      { label: `tdd-red#${attempt}`, phase: 'TDD-RED', model: 'sonnet', agentType: 'tdd-writer', schema: RED },
    )
    if (red?.red_confirmed) break
    if (attempt === 2) return halt(slug, 'TDD RED gate failed twice — tests do not fail for the right reason; needs human eyes', { red })
    log(`RED not confirmed (attempt ${attempt}) — retrying`)
  }
}

// ============================ STAGE 5 — GREEN IMPLEMENT (+ review loop) ============================
phase('Implement')
const impler = (t) => t.owner_agent && /implementer-/.test(t.owner_agent) ? t.owner_agent : (surf.fe ? 'implementer-frontend' : 'implementer-backend')
async function implement(extraFindings) {
  // serialize server.js / critical-path tasks; parallelize the rest
  const serial = tasks.filter((t) => !t.parallel_safe || (t.files || []).some((f) => /server\.js/.test(f)))
  const par = tasks.filter((t) => !serial.includes(t))
  const fixNote = extraFindings ? `\nFIX these confirmed review findings (do not introduce new behavior): ${JSON.stringify(extraFindings).slice(0, 1200)}` : ''
  const runTask = (t) => agent(
    `Repo: ${REPO}. Implement task ${t.id}: ${t.summary}. Files: ${JSON.stringify(t.files || [])}. Intent: "${intent}".${fixNote}\n`
    + `Write ONLY enough to turn the RED tests GREEN — no speculative abstraction. After editing, run \`node --check\` on every edited backend .js. Match surrounding code style. NEVER git add -A. Call hivemind_ingest_code on each file you write. ${scribe(slug, `05-impl-${t.id}.json`, '05')}`,
    { label: `impl:${t.id}`, phase: 'Implement', model: 'sonnet', agentType: impler(t), schema: IMPL },
  )
  for (const t of serial) await runTask(t)            // serial: monolith-safe
  if (par.length) await parallel(par.map((t) => () => runTask(t)))  // parallel: independent files
}
await implement(null)

// ---- Review ↻ Implement loop (bounded; tenant-leak = immediate halt) ----
phase('Review')
let review = null, round = 0
const sevRank = (s) => ({ critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 3)
const REVIEW_DIMS = [
  { key: 'bugs', prompt: 'Find code bugs, logic errors, off-by-ones, unhandled edge cases, and floating promises.' },
  { key: 'security', prompt: 'Find security issues: tenant isolation (EVERY new query must be scoped by org_id/user_id — the recurring leak class here), SQL injection, secrets, OWASP top 10. IMPORTANT: the memories table has NO json metadata column — metadata lives in source_metadata/code_metadata tables; querying metadata->> throws.' },
  { key: 'perf', prompt: 'Find N+1 queries, missing indexes, synchronous blocking in async paths, memory leaks, missing connection-pool limits.' },
  { key: 'db', prompt: 'Find missing DOWN migrations (every schema change needs a rollback), missing FK/index declarations, unscoped tenant queries, SELECT * in production queries.' },
  { key: 'standards', prompt: 'Find console.log in production code, dead imports, eslint-disable without comment, unhandled promises, any TypeScript any.' },
]
const FINDING_SCHEMA = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, detail: { type: 'string' }, dimension: { type: 'string' } }, required: ['title', 'severity', 'dimension'] } } },
  required: ['findings'],
}
const VERDICT_SCHEMA = { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted'] }

async function runReview() {
  const dimResults = await parallel(REVIEW_DIMS.map((d) => () => agent(
    `Repo: ${REPO}. Run \`git diff HEAD\` to see the current uncommitted changes. Review dimension: ${d.key}. ${d.prompt}\nReport ONLY real findings in the DIFF (not pre-existing issues elsewhere). Include file path + approximate line number. Set dimension="${d.key}".`,
    { label: `review:${d.key}`, phase: 'Review', model: 'sonnet', agentType: 'code-reviewer', schema: FINDING_SCHEMA },
  )))
  const allFindings = dimResults.filter(Boolean).flatMap((r) => r.findings || [])
  if (!allFindings.length) return { confirmed: [] }
  const verdicts = await parallel(allFindings.map((f) => () => agent(
    `Adversarially verify this finding — try to REFUTE it.\nFinding: ${JSON.stringify(f).slice(0, 600)}\nRepo: ${REPO}. Read the actual file at the cited location. If the code truly has this issue at that exact spot, set refuted=false. If it is a false positive (wrong line, pre-existing, already handled), set refuted=true. Default to refuted=true when genuinely uncertain.`,
    { label: `verify:${String(f.title).slice(0, 28)}`, phase: 'Review', model: 'sonnet', agentType: 'code-reviewer', schema: VERDICT_SCHEMA },
  ).then((v) => (v && !v.refuted ? f : null))))
  return { confirmed: verdicts.filter(Boolean) }
}

while (round < 3) {
  review = await runReview().catch((e) => { log(`review failed: ${e.message}`); return { confirmed: [] } })
  const confirmed = review?.confirmed || []
  const tenant = confirmed.find((f) => /tenant|isolation|authz|cross-?org|leak/i.test(`${f.title} ${f.dimension} ${f.detail}`))
  if (tenant) return halt(slug, `CONFIRMED tenant-isolation/authz finding — automatic NO-GO, bypasses retry budget: ${tenant.title} (${tenant.file}:${tenant.line})`, { review })
  const blocking = confirmed.filter((f) => sevRank(f.severity) <= 1) // critical|high
  if (blocking.length === 0) { log(`review clean (${confirmed.length} non-blocking finding(s))`); break }
  if (round >= 2) return halt(slug, `review still has ${blocking.length} confirmed critical/high after 2 fix rounds — parked for human`, { review })
  log(`round ${round + 1}: ${blocking.length} blocking finding(s) → loop back to implement`)
  await implement(blocking)
  round++
}

// ============================ STAGE 8 — LOCAL E2E + perf pre-flight ============================
let e2e = null
if (tier !== 'TRIVIAL') {
  phase('E2E')
  for (let attempt = 1; attempt <= 2; attempt++) {
    e2e = await agent(
      `Repo: ${REPO}. Run the local E2E + perf pre-flight for: "${intent}" BEFORE it touches prod. Run the test suite and curl/Playwright the happy + error paths for the touched endpoints locally. ${surf.recall ? 'The recall path is touched — check latency + that the eval harness has not regressed (combo@8≈1.00, MRR≈0.87).' : ''} Report pass/fail per flow + any perf regression. ${scribe(slug, '08-e2e.json', '08')}`,
      { label: `e2e#${attempt}`, phase: 'E2E', model: 'sonnet', agentType: 'e2e-runner', schema: E2E },
    )
    if (e2e?.pass && !e2e?.regressed) break
    if (attempt === 2) return halt(slug, `local E2E/perf failed after a fix round: ${JSON.stringify(e2e).slice(0, 400)}`, { e2e })
    log(`E2E failed (attempt ${attempt}) → one fix round`)
    await implement([{ title: 'E2E/perf failure', detail: JSON.stringify(e2e) }])
  }
}

// ============================ STAGE 9-prep — DOSSIER (park at human gate) ============================
phase('Dossier')
const filesChanged = Array.from(new Set([
  ...tasks.flatMap((t) => t.files || []),
])).filter(Boolean)
const dossier = {
  slug, intent, tier,
  recon_verdict: recon || 'skipped (trivial)',
  design_summary: design?.summary || 'skipped (trivial)',
  threats: (threats?.threats || []),
  files_changed: filesChanged,
  confirmed_review: review?.confirmed || [],
  e2e: e2e || 'skipped (trivial)',
  rollback_order: plan?.rollback_order || plan?.down_migration || 'see 03-plan.json',
  pipeline_dir: PIPE(slug),
}
log('Stage 0–8 complete — PARKED at human ship-gate. Nothing committed to main; nothing deployed.')
return { status: 'awaiting_human_ship_gate', dossier, manifest: `${PIPE(slug)}/manifest.json`, next: 'Review the dossier, then approve to run the ship skill (commit→push→pull→migrate→restart→deploy-verify).' }
