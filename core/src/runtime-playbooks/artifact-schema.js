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
  const selectorsOf = (check) => (Array.isArray(check?.select)
    ? check.select.map(String)
    : (check?.select ? [String(check.select)] : []));
  const keys = new Set([...asArray(stage.expected_artifacts).map(String),
    ...checks.flatMap(selectorsOf)]);
  const out = {};
  for (const key of keys) {
    out[key] = { schema: { type: 'object', properties: {}, required: [] }, requirements: [], minCount: null };
  }
  for (const check of checks) {
   for (const key of selectorsOf(check)) {
    if (!out[key]) continue;
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

/* ────────────────────────────────────────────────────────────────────────────
 * STRICT RESPONSE SCHEMA — the one-attempt mechanism.
 *
 * Measured on the deployed synth model (openai/gpt-oss-120b, 18 runs):
 *   prompt fix alone, response_format json_object ......... 0/3 filled the field
 *   strict schema alone, contradictory prompt ............. 0/1 filled
 *   strict schema + non-contradictory prompt ............. 6/6 non-null
 * Neither half works on its own. An untyped schema is not enough either: with
 * `properties: {channel_mix: {}}` the model returned a STRING where the consumer needs
 * `{organic, paid}`. So the leaves must be TYPED, and the prompt must not contain a
 * sentence that licenses omission.
 *
 * Two inputs, one output, no second copy:
 *   - WHICH fields exist and whether they block  ->  the stage's completion_checks
 *   - WHAT SHAPE each field has                  ->  ARTIFACT_FIELD_SHAPES below
 * A field that predicates demand but the registry does not describe is a hard error the
 * asymmetry test catches, so the two can never silently drift.
 *
 * Strict mode (OpenAI json_schema semantics) forbids free-form objects and requires every
 * property to appear in `required`. Optionality is expressed as a nullable union instead —
 * which maps exactly onto our severities: `required` checks become non-nullable (the field
 * CANNOT come back null), `preferred` checks become nullable-but-present (advisory).
 * ──────────────────────────────────────────────────────────────────────────── */

const STR = { type: 'string' };
const strList = (itemProps) => ({
  type: 'array',
  items: { type: 'object', additionalProperties: false, properties: itemProps, required: Object.keys(itemProps) },
});

/**
 * Typed shapes for LLM-AUTHORED artifact fields, keyed by artifact key.
 *
 * `kind` records WHY a field may be authored, which is the distinction the old prompt
 * collapsed: an `authored` field is the Room's own judgement and withholding it is a
 * failed turn; an `evidence_bound` field is a fact and must never be invented. Adapter
 * artifacts (call_receipt, draft_record, campaign_record …) are produced deterministically
 * in code, never by this schema, so they are deliberately absent here.
 */
export const ARTIFACT_FIELD_SHAPES = {
  marketing_strategy_program: {
    evidence_summary: { kind: 'evidence_bound', schema: strList({ claim: STR, evidence_ref: STR, confidence: STR }) },
    contradictions: { kind: 'evidence_bound', schema: strList({ claim: STR, conflict: STR, evidence_ref: STR }) },
    unknowns: { kind: 'evidence_bound', schema: { type: 'array', items: STR } },
    confidence: { kind: 'authored', schema: STR },
    niche_wedge: { kind: 'authored', schema: STR },
    positioning: { kind: 'authored', schema: STR },
    offer_framing: { kind: 'authored', schema: STR },
    expected_outcome: { kind: 'authored', schema: STR },
    audience: {
      kind: 'authored',
      schema: strList({ segment: STR, sector: STR, size: STR, geography: STR, role: STR, buying_trigger: STR, evidence: STR }),
    },
    messaging_pillars: { kind: 'authored', schema: strList({ pillar: STR, claim: STR, proof_ref: STR }) },
    competitor_plan: {
      kind: 'authored',
      schema: strList({ rival: STR, where_we_win: STR, where_we_lose: STR, differentiating_claim: STR }),
    },
    channel_mix: {
      kind: 'authored',
      schema: {
        type: 'object', additionalProperties: false, required: ['organic', 'paid'],
        properties: { organic: strList({ channel: STR, rationale: STR }), paid: strList({ channel: STR, rationale: STR }) },
      },
    },
    risks: { kind: 'authored', schema: strList({ risk: STR, mitigation: STR }) },
    measures: { kind: 'authored', schema: strList({ metric: STR, target: STR, window: STR, kill_criterion: STR }) },
    dependencies: { kind: 'authored', schema: { type: 'array', items: STR } },
    motions: {
      kind: 'authored',
      schema: {
        type: 'array', minItems: 2, maxItems: 4,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            motion_id: STR, title: STR, objective: STR, reason: STR, expected_outcome: STR,
            playbook_id: STR, playbook_version: { type: 'integer' }, supported_action: STR,
            effect_class: { type: 'string', enum: ['internal', 'external'] },
            required_capabilities: { type: 'array', items: STR }, evidence_refs: { type: 'array', minItems: 1, items: STR },
            success_measure: STR, dependencies: { type: 'array', items: STR }, priority: { type: 'integer' },
          },
          required: ['motion_id', 'title', 'objective', 'reason', 'expected_outcome', 'playbook_id', 'playbook_version',
            'supported_action', 'effect_class', 'required_capabilities', 'evidence_refs', 'success_measure', 'dependencies', 'priority'],
        },
      },
    },
  },
  marketing_evidence_ledger: {
    market_evidence: { kind: 'evidence_bound', schema: strList({ claim: STR, evidence_ref: STR, confidence: STR }) },
    buyer_evidence: { kind: 'evidence_bound', schema: strList({ claim: STR, evidence_ref: STR, confidence: STR }) },
    alternatives: { kind: 'authored', schema: strList({ option: STR, evidence_ref: STR }) },
    contradictions: { kind: 'evidence_bound', schema: strList({ claim: STR, conflict: STR, evidence_ref: STR }) },
    unknowns: { kind: 'evidence_bound', schema: { type: 'array', items: STR } },
    confidence: { kind: 'authored', schema: STR },
  },
  marketing_strategy_decision: {
    chosen_strategy: { kind: 'authored', schema: STR },
    rejected_options: { kind: 'authored', schema: strList({ option: STR, reason: STR }) },
    buying_trigger: { kind: 'authored', schema: STR },
    positioning: { kind: 'authored', schema: STR },
    offer_architecture: { kind: 'authored', schema: STR },
    buyer_journey: { kind: 'authored', schema: STR },
    brand_direction: { kind: 'authored', schema: STR },
    validation_risks: { kind: 'authored', schema: strList({ risk: STR, test: STR }) },
  },
  first_life_motion_portfolio: {
    strategy_ref: { kind: 'evidence_bound', schema: STR },
    motions: {
      kind: 'authored',
      schema: {
        type: 'array', minItems: 2, maxItems: 4,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            motion_id: STR, title: STR, objective: STR, reason: STR, expected_outcome: STR,
            playbook_id: STR, playbook_version: { type: 'integer' }, supported_action: STR,
            effect_class: { type: 'string', enum: ['internal', 'external'] },
            required_capabilities: { type: 'array', items: STR }, evidence_refs: { type: 'array', minItems: 1, items: STR },
            success_measure: STR, dependencies: { type: 'array', items: STR }, priority: { type: 'integer' },
          },
          required: ['motion_id', 'title', 'objective', 'reason', 'expected_outcome', 'playbook_id', 'playbook_version',
            'supported_action', 'effect_class', 'required_capabilities', 'evidence_refs', 'success_measure', 'dependencies', 'priority'],
        },
      },
    },
  },
  marketing_strategy: {
    niche_wedge: { kind: 'authored', schema: STR },
    positioning: { kind: 'authored', schema: STR },
    offer_framing: { kind: 'authored', schema: STR },
    expected_outcome: { kind: 'authored', schema: STR },
    audience: {
      kind: 'authored',
      // Concrete enough to DISCOVER prospects from — that is the whole point of the field,
      // so sector/geography/role are structural, not prose the model may skip.
      schema: strList({ segment: STR, sector: STR, size: STR, geography: STR, role: STR, buying_trigger: STR, evidence: STR }),
    },
    competitor_plan: {
      kind: 'authored',
      schema: strList({ rival: STR, where_we_win: STR, where_we_lose: STR, differentiating_claim: STR }),
    },
    channel_mix: {
      kind: 'authored',
      schema: {
        type: 'object', additionalProperties: false, required: ['organic', 'paid'],
        properties: { organic: strList({ channel: STR, rationale: STR }), paid: strList({ channel: STR, rationale: STR }) },
      },
    },
    recommended_next_motions: {
      kind: 'authored',
      schema: {
        type: 'object', additionalProperties: false, required: ['outreach_emails', 'tara_calls', 'campaign'],
        properties: {
          outreach_emails: strList({ icp: STR, subject: STR, opening_line: STR }),
          tara_calls: strList({ prospect_profile: STR, call_goal: STR, opening: STR }),
          campaign: strList({ concept: STR, cta: STR }),
        },
      },
    },
    risks: { kind: 'authored', schema: strList({ risk: STR, mitigation: STR }) },
    measures: { kind: 'authored', schema: strList({ metric: STR, target: STR, window: STR, kill_criterion: STR }) },
    dependencies: { kind: 'authored', schema: { type: 'array', items: STR } },
    portfolio_ref: { kind: 'evidence_bound', schema: STR },
  },
  research_decision: {
    decision: { kind: 'authored', schema: STR },
    evidence: { kind: 'evidence_bound', schema: strList({ claim: STR, source_ref: STR, confidence: STR }) },
    unknowns: { kind: 'evidence_bound', schema: { type: 'array', items: STR } },
    recommendation: { kind: 'authored', schema: STR },
  },
};

/** Make a leaf nullable for a `preferred` field: absence is advisory, not a block. */
function nullable(schema) {
  const type = schema.type;
  if (!type || Array.isArray(type)) return schema;
  return { ...schema, type: [type, 'null'] };
}

/**
 * The full strict response envelope for a stage, or null when strict mode does not apply.
 *
 * Deliberately narrow: strict output is emitted ONLY when the stage expects exactly one
 * artifact key AND that key has a registered shape. A multi-key stage would need a union
 * for `data`, and an unregistered key has no types to enforce — both keep today's
 * json_object behaviour rather than guessing. The registry grows per key.
 *
 * @returns {{name: string, schema: object, fields: {required: string[], preferred: string[]}}|null}
 */
export function deriveStrictResponseSchema(stage = {}) {
  const expected = asArray(stage.expected_artifacts).map(String);
  if (expected.length !== 1) return null;
  const [key] = expected;
  const shapes = ARTIFACT_FIELD_SHAPES[key];
  if (!shapes) return null;

  const { artifacts } = deriveStageArtifactContract(stage);
  const contract = artifacts[key];
  if (!contract) return null;
  const requiredFields = asArray(contract.schema?.required).map(String)
    .filter((field) => field !== 'data');
  // `deriveStageArtifactContract` nests field checks under a `data` object.
  const dataNode = contract.schema?.properties?.data || {};
  const required = asArray(dataNode.required).map(String);
  const documented = Object.keys(dataNode.properties || {});
  const preferred = documented.filter((field) => !required.includes(field));
  const fields = [...new Set([...required, ...preferred, ...requiredFields])];
  if (!fields.length) return null;

  const properties = {};
  const missing = [];
  for (const field of fields) {
    const entry = shapes[field];
    if (!entry) { missing.push(field); continue; }
    properties[field] = required.includes(field) ? entry.schema : nullable(entry.schema);
  }
  // A predicate demands a field the registry cannot type: refuse to emit a schema that
  // silently drops it. Falling back to json_object is strictly better than constraining
  // the model to an envelope that forbids the very field about to be checked.
  if (missing.length) return null;

  const dataSchema = { type: 'object', additionalProperties: false, properties, required: fields };
  return {
    name: `${key}_result`,
    fields: { required, preferred },
    schema: {
      type: 'object', additionalProperties: false,
      required: ['contract', 'run_id', 'stage_id', 'artifacts', 'gaps', 'summary'],
      properties: {
        contract: STR, run_id: STR, stage_id: STR, summary: STR,
        gaps: { type: 'array', items: STR },
        artifacts: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'key', 'status', 'data', 'source_refs'],
            properties: {
              id: STR, key: STR, status: STR,
              source_refs: { type: 'array', items: STR },
              data: dataSchema,
            },
          },
        },
      },
    },
  };
}
