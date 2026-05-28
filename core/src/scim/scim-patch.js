/**
 * SCIM 2.0 PATCH operation applier (RFC 7644 §3.5.2).
 *
 * Handles the path subset Okta + Azure actually send:
 *   - bare attr                 (e.g. "displayName")
 *   - dotted sub-attr           (e.g. "name.givenName")
 *   - multi-valued by index     (e.g. "emails[0].value")
 *   - multi-valued by filter    (e.g. "emails[type eq \"work\"].value")
 *   - members add/remove        (e.g. "members" with array value)
 *
 * Returns a normalized list of operations: { op, target, value, filter }.
 * Caller decides how to apply per resource type.
 */

const COMPLEX_RE = /^([A-Za-z][\w-]*)\[(\w+)\s+(\w+)\s+"([^"]+)"\](?:\.(\w+))?$/;
const INDEX_RE   = /^([A-Za-z][\w-]*)\[(\d+)\](?:\.(\w+))?$/;
const DOT_RE     = /^([A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*)$/;

export function parseScimPath(path) {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  const complex = trimmed.match(COMPLEX_RE);
  if (complex) {
    const [, attr, filterAttr, filterOp, filterVal, subAttr] = complex;
    return {
      kind: 'filter',
      attr,
      sub: subAttr || null,
      filter: { attr: filterAttr, op: filterOp.toLowerCase(), value: filterVal },
    };
  }

  const indexed = trimmed.match(INDEX_RE);
  if (indexed) {
    const [, attr, idx, subAttr] = indexed;
    return { kind: 'index', attr, index: Number(idx), sub: subAttr || null };
  }

  const dotted = trimmed.match(DOT_RE);
  if (dotted) {
    const parts = dotted[1].split('.');
    return { kind: 'dot', attr: parts[0], sub: parts.slice(1).join('.') || null };
  }

  return null;
}

/**
 * Apply a single PATCH op to a resource object IN-MEMORY. Returns the new
 * resource. Caller persists. Op `op` is 'add'|'replace'|'remove'.
 */
export function applyScimPatchOp(resource, op) {
  if (!resource || typeof resource !== 'object') return resource;
  const action = String(op.op || '').toLowerCase();
  if (!['add', 'replace', 'remove'].includes(action)) return resource;

  const next = { ...resource };

  // Path-less op = apply value as a partial object merge (RFC §3.5.2.1).
  if (!op.path) {
    if (!op.value || typeof op.value !== 'object') return resource;
    for (const [k, v] of Object.entries(op.value)) {
      if (action === 'remove') delete next[k];
      else next[k] = v;
    }
    return next;
  }

  const path = parseScimPath(op.path);
  if (!path) return resource;

  if (path.kind === 'dot') {
    if (!path.sub) {
      if (action === 'remove') delete next[path.attr];
      else next[path.attr] = op.value;
    } else {
      // Dotted nested: name.givenName.
      const parent = { ...(next[path.attr] || {}) };
      const subParts = path.sub.split('.');
      let cursor = parent;
      for (let i = 0; i < subParts.length - 1; i += 1) {
        const k = subParts[i];
        cursor[k] = { ...(cursor[k] || {}) };
        cursor = cursor[k];
      }
      const leaf = subParts[subParts.length - 1];
      if (action === 'remove') delete cursor[leaf];
      else cursor[leaf] = op.value;
      next[path.attr] = parent;
    }
    return next;
  }

  if (path.kind === 'index') {
    const arr = Array.isArray(next[path.attr]) ? [...next[path.attr]] : [];
    while (arr.length <= path.index) arr.push({});
    if (path.sub) {
      const elem = { ...(arr[path.index] || {}) };
      if (action === 'remove') delete elem[path.sub];
      else elem[path.sub] = op.value;
      arr[path.index] = elem;
    } else {
      if (action === 'remove') arr.splice(path.index, 1);
      else if (action === 'add') arr.push(op.value);
      else arr[path.index] = op.value;
    }
    next[path.attr] = arr;
    return next;
  }

  if (path.kind === 'filter') {
    const arr = Array.isArray(next[path.attr]) ? [...next[path.attr]] : [];
    const matches = (elem) => {
      const lhs = elem?.[path.filter.attr];
      const rhs = path.filter.value;
      switch (path.filter.op) {
        case 'eq': return lhs === rhs;
        case 'ne': return lhs !== rhs;
        case 'co': return typeof lhs === 'string' && lhs.includes(rhs);
        case 'sw': return typeof lhs === 'string' && lhs.startsWith(rhs);
        case 'ew': return typeof lhs === 'string' && lhs.endsWith(rhs);
        default:   return false;
      }
    };
    let touched = false;
    const updated = arr.map((elem) => {
      if (!matches(elem)) return elem;
      touched = true;
      const fresh = { ...elem };
      if (path.sub) {
        if (action === 'remove') delete fresh[path.sub];
        else fresh[path.sub] = op.value;
        return fresh;
      }
      if (action === 'remove') return null;
      return { ...fresh, ...(op.value || {}) };
    }).filter(Boolean);
    if (!touched && action !== 'remove') {
      const seed = path.sub ? { [path.filter.attr]: path.filter.value, [path.sub]: op.value } : { [path.filter.attr]: path.filter.value, ...(op.value || {}) };
      updated.push(seed);
    }
    next[path.attr] = updated;
    return next;
  }

  return next;
}

export function applyScimPatch(resource, operations) {
  if (!Array.isArray(operations) || operations.length === 0) return resource;
  return operations.reduce((acc, op) => applyScimPatchOp(acc, op), resource);
}
