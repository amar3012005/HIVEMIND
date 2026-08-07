/**
 * artifact-schema.js — derive the artifact contract FROM the predicates.
 *
 * The required shape of a stage's artifacts lived in two places: the machine
 * `completion_checks` and the human `objective` prose. They drifted, and that drift is
 * the failure class behind form_strategy / prepare_provider_drafts /
 * prepare_campaign_contract — a Room was told in a paragraph what a predicate then
 * demanded byte-exactly, and any mismatch cost a full Room turn (gather, web search,
 * debate, synthesis) before surfacing as an opaque `all_have_nonempty_field:x:3`.
 *
 * One source of truth: read the checks, emit (a) a JSON Schema per artifact key for
 * schema-constrained generation, and (b) a plain-language requirement list that can be
 * injected into the objective so the prose can never disagree with the predicate.
 *
 * Severity-aware: `preferred` checks become documented-but-not-required, matching the
 * predicate engine (only required checks block a stage).
 *
 * Pure and dependency-free so it can be unit-tested against every shipped fixture.
 */

const FIELD_PREDICATES = new Set([
  'has_field', 'all_have_field', 'all_have_nonempty_field', 'field_equals',
  'latest_field_equals', 'field_not_equals', 'field_contains_value', 'field_in',
  'field_gte', 'field_lte', 'field_matches', 'all_have_min_items',
]);
const COUNT_PREDICATES = new Set(['has_min_count', 'has_max_count', 'has_exact_count', 'count_matches']);

const asArray = (value) => (Array.isArray(value) ? value : []);
const severityOf = (check) => (String(check?.severity || 'required').trim().toLowerCase() === 'preferred' ? 'preferred' : 'required');

/** `data.channel_mix.paid` -> ['data','channel_mix','paid'] (empty for a bare/absent path). */
function pathSegments(path) {
  return String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
}

/** Nest a required leaf into an object schema, creating intermediate objects. */
function requireLeaf(schema, segments) {
  if (!segments.length) return;
  const [head, ...rest] = segments;
  schema.properties = schema.properties || {};
  schema.required = Array.from(new Set([...(schema.required || []), head]));
  if (!rest.length) {
    schema.properties[head] = schema.properties[head] || {};
    return;
  }
  const child = schema.properties[head] && typeof schema.properties[head] === 'object'
    ? schema.properties[head] : {};
  child.type = child.type || 'object';
  schema.properties[head] = child;
  requireLeaf(child, rest);
}

/**
 * Document a leaf WITHOUT requiring it — a `preferred` field the producer should author
 * but whose absence must never block generation. Creates the intermediate objects so a
 * nested preferred path (data.recommended_next_motions) is still visible in the schema.
 */
function documentLeaf(schema, segments) {
  if (!segments.length) return;
  const [head, ...rest] = segments;
  schema.properties = schema.properties || {};
  const existing = schema.properties[head] && typeof schema.properties[head] === 'object'
    ? schema.properties[head] : {};
  if (rest.length) existing.type = existing.type || 'object';
  schema.properties[head] = existing;
  if (rest.length) documentLeaf(existing, rest);
}

/**
 * Derive per-artifact-key contracts from a stage.
 * @returns {{ artifacts: Record<string, {schema: object, requirements: string[], minCount: number|null}> }}
 */
export function deriveStageArtifactContract(stage = {}) {
  const checks = asArray(stage.completion_checks);
  const keys = new Set([...asArray(stage.expected_artifacts).map(String),
    ...checks.map((check) => String(check?.select || '')).filter(Boolean)]);
  const out = {};
  for (const key of keys) {
    out[key] = { schema: { type: 'object', properties: {}, required: [] }, requirements: [], minCount: null };
  }
  for (const check of checks) {
    const key = String(check?.select || '');
    if (!key || !out[key]) continue;
    const target = out[key];
    const predicate = String(check?.predicate || '');
    const severity = severityOf(check);
    const segments = pathSegments(check?.path);
    if (COUNT_PREDICATES.has(predicate)) {
      if (predicate === 'has_min_count' && Number.isFinite(Number(check.value))) target.minCount = Number(check.value);
      target.requirements.push(`${severity === 'preferred' ? '(preferred) ' : ''}${predicate} ${check.value ?? ''}`.trim());
      continue;
    }
    if (predicate === 'is_source_backed') {
      target.requirements.push(`${severity === 'preferred' ? '(preferred) ' : ''}every artifact must carry non-empty source_refs`);
      continue;
    }
    if (FIELD_PREDICATES.has(predicate) && segments.length) {
      // Only REQUIRED field checks enter `required` — a preferred field is documented
      // so the producer knows to author it, but its absence must not block generation.
      if (severity === 'required') requireLeaf(target.schema, segments);
      else documentLeaf(target.schema, segments);
      target.requirements.push(
        `${severity === 'preferred' ? '(preferred) ' : ''}${check.path} — ${predicate.replace(/_/g, ' ')}`
        + (check.value !== undefined ? ` (${JSON.stringify(check.value)})` : ''),
      );
      continue;
    }
    target.requirements.push(`${severity === 'preferred' ? '(preferred) ' : ''}${predicate}`);
  }
  return { artifacts: out };
}

/**
 * Plain-language requirement block, generated from the SAME checks the engine runs, so
 * an objective can embed it instead of restating the shape by hand.
 */
export function renderArtifactRequirements(stage = {}) {
  const { artifacts } = deriveStageArtifactContract(stage);
  const lines = [];
  for (const [key, contract] of Object.entries(artifacts)) {
    if (!contract.requirements.length) continue;
    lines.push(`Artifact \`${key}\`${contract.minCount ? ` (at least ${contract.minCount})` : ''}:`);
    for (const requirement of contract.requirements) lines.push(`  - ${requirement}`);
  }
  return lines.join('\n');
}

export default deriveStageArtifactContract;
