/**
 * SCIM 2.0 Filter Parser (RFC 7644 §3.4.2.2 subset).
 *
 * Supported grammar:
 *   filter  = clause [ " and " clause ]
 *   clause  = attrPath SP operator SP value
 *   operator = "eq" | "co"
 *   value   = '"' string '"' | "true" | "false"
 *   attrPath = "userName" | "email" | "active" | "displayName"
 *
 * Returns a Prisma `where` fragment for the User model.
 * Throws ScimFilterError (status 400) on unsupported operators or attributes.
 */

export class ScimFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScimFilterError';
    this.status = 400;
    this.scimType = 'invalidFilter';
  }
}

const SUPPORTED_ATTRS = new Set(['userName', 'email', 'active', 'displayName']);
const SUPPORTED_OPS = new Set(['eq', 'co']);

/**
 * Parse a single filter clause into a Prisma where condition.
 * @param {string} clause  e.g. `userName eq "alice@example.com"`
 * @returns {object} Prisma where sub-object
 */
function parseClause(clause) {
  const trimmed = clause.trim();
  // Match: <attr> <op> <value>
  const m = trimmed.match(/^(\w+)\s+(\w+)\s+(.+)$/i);
  if (!m) throw new ScimFilterError(`Unparseable filter clause: ${trimmed}`);

  const [, attr, op, rawVal] = m;

  if (!SUPPORTED_ATTRS.has(attr)) {
    throw new ScimFilterError(`Unsupported filter attribute: ${attr}`);
  }
  if (!SUPPORTED_OPS.has(op.toLowerCase())) {
    throw new ScimFilterError(`Unsupported filter operator: ${op}. Only "eq" and "co" are supported.`);
  }

  // Parse value
  let value;
  if (rawVal === 'true') {
    value = true;
  } else if (rawVal === 'false') {
    value = false;
  } else if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
    value = rawVal.slice(1, -1);
  } else {
    throw new ScimFilterError(`Unparseable filter value: ${rawVal}`);
  }

  const opNorm = op.toLowerCase();

  // Map SCIM attribute → Prisma field
  switch (attr) {
    case 'userName':
    case 'email':
      // userName and email both map to User.email
      if (opNorm === 'eq') return { email: value };
      if (opNorm === 'co') return { email: { contains: value, mode: 'insensitive' } };
      break;
    case 'displayName':
      if (opNorm === 'eq') return { displayName: value };
      if (opNorm === 'co') return { displayName: { contains: value, mode: 'insensitive' } };
      break;
    case 'active':
      // SCIM `active` maps to UserOrganization.isActive (handled in query layer).
      // Return a special sentinel — callers must handle this.
      return { __scim_active: value };
    default:
      throw new ScimFilterError(`Unsupported filter attribute: ${attr}`);
  }
  // Unreachable but satisfies linter
  throw new ScimFilterError(`Filter parse error`);
}

/**
 * Parse a full SCIM filter expression.
 * @param {string} filter
 * @returns {object} Combined Prisma where sub-object (ANDed clauses)
 */
export function parseScimFilter(filter) {
  if (!filter || !filter.trim()) return {};

  // Split on " and " (case-insensitive)
  const clauses = filter.split(/\s+and\s+/i);

  const conditions = clauses.map(parseClause);

  // Merge conditions: plain fields merge directly; duplicates become AND array
  const merged = {};
  const andParts = [];

  for (const cond of conditions) {
    // __scim_active is a sentinel — caller must handle at the join query level
    if ('__scim_active' in cond) {
      merged.__scim_active = cond.__scim_active;
      continue;
    }
    andParts.push(cond);
  }

  if (andParts.length === 1) {
    Object.assign(merged, andParts[0]);
  } else if (andParts.length > 1) {
    merged.AND = andParts;
  }

  return merged;
}
