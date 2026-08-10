function getPath(value, path) {
  if (!path) return value;
  return String(path).split('.').reduce((current, part) => {
    if (current == null) return undefined;
    return current[part];
  }, value);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function materializeCheck(check, context) {
  const resolved = { ...check };
  if (check.value_from) {
    const value = getPath(context, check.value_from);
    resolved.value = value == null ? check.default_value : value;
  }
  if (check.values_from) {
    const values = getPath(context, check.values_from);
    resolved.values = values == null ? check.default_values : values;
  }
  return resolved;
}

function selectArtifacts(artifacts, select) {
  const selectors = asArray(select);
  if (Array.isArray(artifacts)) return artifacts.filter((artifact) => selectors.includes(artifact?.key));
  return selectors.flatMap((key) => asArray(artifacts?.[key]));
}

function compareSelected(artifacts, check, comparator) {
  const selected = selectArtifacts(artifacts, check.select);
  if (selected.length === 0) return false;
  const matches = selected.map((artifact) => comparator(getPath(artifact, check.path), artifact));
  return check.mode === 'any' ? matches.some(Boolean) : matches.every(Boolean);
}

const predicates = {
  exists: ({ artifacts, check }) => selectArtifacts(artifacts, check.select).length > 0,
  has_min_count: ({ artifacts, check }) => selectArtifacts(artifacts, check.select).length >= check.value,
  has_max_count: ({ artifacts, check }) => selectArtifacts(artifacts, check.select).length <= check.value,
  has_exact_count: ({ artifacts, check }) => selectArtifacts(artifacts, check.select).length === check.value,
  count_matches: ({ artifacts, check }) => (
    selectArtifacts(artifacts, check.select).length === selectArtifacts(artifacts, check.target_select).length
  ),
  references_cover_all: ({ artifacts, check }) => {
    const targetValues = selectArtifacts(artifacts, check.target_select)
      .map((artifact) => getPath(artifact, check.target_path || 'id'));
    const outcomeValues = selectArtifacts(artifacts, check.select)
      .map((artifact) => getPath(artifact, check.path));
    if (targetValues.length === 0 || outcomeValues.length !== targetValues.length) return false;
    const targets = new Set(targetValues);
    return targets.size === targetValues.length
      && outcomeValues.every((value) => value != null && targets.has(value))
      && new Set(outcomeValues).size === outcomeValues.length;
  },
  has_field: ({ artifacts, check }) => compareSelected(artifacts, { ...check, mode: 'any' }, (value) => value !== undefined && value !== null),
  all_have_field: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => value !== undefined && value !== null),
  all_have_nonempty_field: ({ artifacts, check }) => compareSelected(
    artifacts,
    check,
    (value) => value != null && (typeof value !== 'string' || value.trim().length > 0),
  ),
  none_have_field: ({ artifacts, check }) => {
    const selected = selectArtifacts(artifacts, check.select);
    return selected.length > 0 && selected.every((artifact) => getPath(artifact, check.path) == null);
  },
  field_equals: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => value === check.value),
  latest_field_equals: ({ artifacts, check }) => {
    const selected = selectArtifacts(artifacts, check.select);
    if (selected.length === 0) return false;
    return getPath(selected.at(-1), check.path) === check.value;
  },
  field_not_equals: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => value !== check.value),
  field_contains_value: ({ artifacts, check }) => {
    const expected = String(check.value ?? '').trim().toLocaleLowerCase();
    if (!expected) return check.allow_missing_value === true;
    return compareSelected(
      artifacts,
      check,
      (value) => typeof value === 'string' && value.toLocaleLowerCase().includes(expected),
    );
  },
  field_in: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => asArray(check.values).includes(value)),
  status_in: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => asArray(check.values).includes(value)),
  field_gte: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => Number.isFinite(value) && value >= check.value),
  field_lte: ({ artifacts, check }) => compareSelected(artifacts, check, (value) => Number.isFinite(value) && value <= check.value),
  field_matches: ({ artifacts, check }) => {
    let expression;
    try {
      expression = new RegExp(check.pattern, check.flags || '');
    } catch {
      return false;
    }
    return compareSelected(artifacts, check, (value) => typeof value === 'string' && expression.test(value));
  },
  all_have_min_items: ({ artifacts, check }) => compareSelected(
    artifacts,
    check,
    (value) => Array.isArray(value) && value.length >= check.value,
  ),
  array_has_field_value: ({ artifacts, check }) => compareSelected(
    artifacts,
    check,
    (value) => Array.isArray(value) && value.some(
      (item) => getPath(item, check.item_path) === check.value,
    ),
  ),
  unique_by: ({ artifacts, check }) => {
    const values = selectArtifacts(artifacts, check.select).map((artifact) => getPath(artifact, check.path));
    return values.length > 0 && values.every((value) => value != null) && new Set(values).size === values.length;
  },
  all_reference_existing: ({ artifacts, check }) => {
    const targets = new Set(
      selectArtifacts(artifacts, check.target_select).map((artifact) => getPath(artifact, check.target_path || 'id')),
    );
    const selected = selectArtifacts(artifacts, check.select);
    return selected.length > 0 && selected.every((artifact) => targets.has(getPath(artifact, check.path)));
  },
  is_source_backed: ({ artifacts, check }) => compareSelected(
    artifacts,
    check,
    (value, artifact) => asArray(value ?? getPath(artifact, check.source_path || 'source_refs')).filter(Boolean).length >= (check.value || 1),
  ),
  has_provider_receipt: ({ artifacts, check }) => compareSelected(
    artifacts,
    { ...check, path: check.receipt_path || check.path },
    (value) => typeof value === 'string' && value.trim().length > 0,
  ),
  no_failures: ({ artifacts, check }) => compareSelected(
    artifacts,
    { ...check, path: check.path || 'status' },
    (value) => !asArray(check.failure_values || ['failed', 'error']).includes(String(value || '').toLowerCase()),
  ),
};

const requiredArguments = {
  exists: ['select'],
  has_min_count: ['select', 'value'],
  has_max_count: ['select', 'value'],
  has_exact_count: ['select', 'value'],
  count_matches: ['select', 'target_select'],
  references_cover_all: ['select', 'path', 'target_select'],
  has_field: ['select', 'path'],
  all_have_field: ['select', 'path'],
  all_have_nonempty_field: ['select', 'path'],
  none_have_field: ['select', 'path'],
  field_equals: ['select', 'path', 'value'],
  latest_field_equals: ['select', 'path', 'value'],
  field_not_equals: ['select', 'path', 'value'],
  field_contains_value: ['select', 'path', 'value'],
  field_in: ['select', 'path', 'values'],
  status_in: ['select', 'path', 'values'],
  field_gte: ['select', 'path', 'value'],
  field_lte: ['select', 'path', 'value'],
  field_matches: ['select', 'path', 'pattern'],
  all_have_min_items: ['select', 'path', 'value'],
  array_has_field_value: ['select', 'path', 'item_path', 'value'],
  unique_by: ['select', 'path'],
  all_reference_existing: ['select', 'path', 'target_select'],
  is_source_backed: ['select'],
  has_provider_receipt: ['select'],
  no_failures: ['select'],
};

function validateCheckArguments(check) {
  for (const field of requiredArguments[check.predicate] || []) {
    if (!(field in check)) throw new Error(`runtime_predicate_argument_missing:${check.predicate}:${field}`);
  }
  if (check.predicate === 'has_provider_receipt' && !check.receipt_path && !check.path) {
    throw new Error('runtime_predicate_argument_missing:has_provider_receipt:receipt_path');
  }
}

function checkIdentity(check, index) {
  return check.id || `${check.predicate}:${check.select || '*'}:${index}`;
}

export class PredicateEngine {
  constructor({ extensions = {} } = {}) {
    this.predicates = new Map(Object.entries({ ...predicates, ...extensions }));
  }

  names() {
    return [...this.predicates.keys()].sort();
  }

  validateChecks(checks, artifacts, context = {}) {
    const results = checks.map((rawCheck, index) => {
      const check = materializeCheck(rawCheck, context);
      const predicate = this.predicates.get(check.predicate);
      if (!predicate) throw new Error(`runtime_predicate_unknown:${check.predicate}`);
      validateCheckArguments(check);
      let passed = false;
      let error = null;
      try {
        passed = predicate({ artifacts, check, context }) === true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // severity: 'required' (default) blocks the stage; 'preferred' degrades to a
      // recorded gap. Every check used to block, so one missing nice-to-have field
      // (e.g. data.recommended_next_motions) discarded an otherwise complete strategy
      // and dead-ended the todo. A stage that satisfies every REQUIRED check must be
      // able to finish while still reporting what is thin.
      const severity = String(rawCheck?.severity || 'required').trim().toLowerCase() === 'preferred'
        ? 'preferred' : 'required';
      return {
        id: checkIdentity(rawCheck, index),
        predicate: check.predicate,
        passed,
        severity,
        ...(error ? { error } : {}),
      };
    });
    const unmet = results.filter((result) => !result.passed);
    const blocking = unmet.filter((result) => result.severity !== 'preferred');
    const advisory = unmet.filter((result) => result.severity === 'preferred');
    return {
      // Only REQUIRED failures block. Advisory misses travel as gaps/warnings.
      passed: blocking.length === 0,
      results,
      // `unmet` stays the blocking set so existing callers (verdict copy, repair
      // prompts, event details) keep describing what actually stopped the stage.
      unmet: blocking,
      advisory_unmet: advisory,
      gaps: advisory.map((result) => `${result.predicate}${result.id ? `:${result.id}` : ''} (preferred, not satisfied)`),
    };
  }

  evaluate(check, artifacts, context = {}) {
    return this.validateChecks([check], artifacts, context).passed;
  }
}

export const defaultPredicateNames = Object.freeze(Object.keys(predicates).sort());
