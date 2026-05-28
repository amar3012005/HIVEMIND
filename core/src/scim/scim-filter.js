/**
 * SCIM 2.0 filter parser (RFC 7644 §3.4.2).
 *
 * Supported operators: eq, ne, co, sw, ew, pr, gt, ge, lt, le, and, or.
 * Path syntax for attribute names: dot notation only (e.g. name.givenName,
 * emails.value). Complex filter combinators (and/or) require parentheses.
 *
 * Returns a Prisma `where` fragment when the AST maps cleanly to one of our
 * supported fields. Unmappable fields return `null` so the caller can fall
 * back to "match all" semantics rather than 500ing.
 */

const SUPPORTED_OPS = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'pr', 'gt', 'ge', 'lt', 'le']);

const FIELD_MAP = {
  username:        { col: 'email',       caseInsensitive: true },
  'emails.value':  { col: 'email',       caseInsensitive: true },
  email:           { col: 'email',       caseInsensitive: true },
  displayname:     { col: 'displayName', caseInsensitive: true },
  externalid:      { col: 'id' },
  id:              { col: 'id' },
  active:          { col: '_uo_active' }, // virtual — handled in caller
};

const GROUP_FIELD_MAP = {
  displayname: { col: 'name', caseInsensitive: true },
  id:          { col: 'id' },
};

// Tokenizer for SCIM filter grammar.
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '(' || c === ')') { tokens.push({ type: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1, val = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) { val += input[j + 1]; j += 2; }
        else { val += input[j]; j += 1; }
      }
      if (j >= input.length) throw new Error('unterminated string in filter');
      tokens.push({ type: 'string', value: val });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j += 1;
      const word = input.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === 'and' || lower === 'or') tokens.push({ type: 'logic', value: lower });
      else if (SUPPORTED_OPS.has(lower)) tokens.push({ type: 'op', value: lower });
      else tokens.push({ type: 'ident', value: word });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push({ type: 'number', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    throw new Error(`unexpected char ${c}`);
  }
  return tokens;
}

// Recursive-descent parser. Returns AST: {kind: 'cmp'|'logic', ...}
function parseExpr(tokens) {
  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function parseAtom() {
    if (peek()?.type === '(') {
      consume();
      const expr = parseLogic();
      if (peek()?.type !== ')') throw new Error('missing )');
      consume();
      return expr;
    }
    const ident = consume();
    if (!ident || ident.type !== 'ident') throw new Error('expected attribute name');
    if (peek()?.type === 'op' && peek().value === 'pr') {
      consume();
      return { kind: 'cmp', attr: ident.value, op: 'pr', value: null };
    }
    const op = consume();
    if (!op || op.type !== 'op') throw new Error(`expected operator after ${ident.value}`);
    const val = consume();
    if (!val) throw new Error('expected value');
    return { kind: 'cmp', attr: ident.value, op: op.value, value: val.value };
  }
  function parseAnd() {
    let left = parseAtom();
    while (peek()?.type === 'logic' && peek().value === 'and') {
      consume();
      left = { kind: 'logic', op: 'and', left, right: parseAtom() };
    }
    return left;
  }
  function parseLogic() {
    let left = parseAnd();
    while (peek()?.type === 'logic' && peek().value === 'or') {
      consume();
      left = { kind: 'logic', op: 'or', left, right: parseAnd() };
    }
    return left;
  }
  const ast = parseLogic();
  if (pos !== tokens.length) throw new Error('trailing tokens');
  return ast;
}

export function parseScimFilter(input) {
  if (!input) return null;
  const tokens = tokenize(String(input));
  return parseExpr(tokens);
}

// Map a single cmp node to a Prisma where fragment, given a field map.
function cmpToPrisma(node, fieldMap) {
  const lower = node.attr.toLowerCase();
  const map = fieldMap[lower];
  if (!map) return null; // unmappable attr — caller decides
  const col = map.col;
  // Active flag is handled at the caller (filters UserOrganization).
  if (col === '_uo_active') return { _uoActive: node.value === true || node.value === 'true' };
  const mode = map.caseInsensitive ? 'insensitive' : undefined;
  switch (node.op) {
    case 'eq': return { [col]: mode ? { equals: String(node.value), mode } : node.value };
    case 'ne': return { NOT: { [col]: mode ? { equals: String(node.value), mode } : node.value } };
    case 'co': return { [col]: { contains: String(node.value), mode } };
    case 'sw': return { [col]: { startsWith: String(node.value), mode } };
    case 'ew': return { [col]: { endsWith: String(node.value), mode } };
    case 'pr': return { [col]: { not: null } };
    case 'gt': return { [col]: { gt: node.value } };
    case 'ge': return { [col]: { gte: node.value } };
    case 'lt': return { [col]: { lt: node.value } };
    case 'le': return { [col]: { lte: node.value } };
    default: return null;
  }
}

export function scimFilterToPrisma(input, resource = 'user') {
  let ast;
  try { ast = parseScimFilter(input); } catch { return { where: undefined, error: 'invalid_filter' }; }
  if (!ast) return { where: undefined };
  const map = resource === 'group' ? GROUP_FIELD_MAP : FIELD_MAP;

  function walk(node) {
    if (node.kind === 'cmp') return cmpToPrisma(node, map);
    if (node.kind === 'logic') {
      const left = walk(node.left);
      const right = walk(node.right);
      if (!left && !right) return null;
      if (!left) return right;
      if (!right) return left;
      return node.op === 'and' ? { AND: [left, right] } : { OR: [left, right] };
    }
    return null;
  }
  const where = walk(ast);
  return { where };
}
