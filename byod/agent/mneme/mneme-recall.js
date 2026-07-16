// .amr recall that reuses the hybrid pipeline UNCHANGED. searchMemories builds a Qdrant filter
// (org_id, user_id, project, project_ids, layer, tags, is_latest, must_not promoted-from-segment,
// etc.) and the whole stack above (ResultReranker, crossEncoder, ThreeTier multi-scope, hydration)
// stays as-is. We only swap the lowest-level store call: instead of POSTing the vector+filter to
// Qdrant, we recall candidates from the .amr shard (ALL layers) and apply the SAME filter here. That
// preserves every feature — project-scope, entity, cross-layer (memory+evidence), multi-scope
// parallel, bi-temporal is_latest, promoted exclusion — because the filter is the pipeline's own.

// Qdrant payload key (snake) → stored .amr record field (Prisma camel). Unmapped keys pass through.
const KEY_MAP = {
  org_id: 'orgId', user_id: 'userId', memory_type: 'memoryType', is_latest: 'isLatest',
  created_at: 'createdAt', document_date: 'documentDate', team_id: 'teamId',
  valid_from: 'validFrom', valid_to: 'validTo',
  project_ids: 'projectIds', primary_team_id: 'primaryTeamId',
};
function field(rec, qkey) {
  return rec[KEY_MAP[qkey] || qkey];
}

// one Qdrant match clause ({value} / {any:[]} / {except:[]}) against a scalar-or-array record value.
function matchCond(val, match) {
  if (!match) return true;
  const hit = (x) => (Array.isArray(val) ? val.includes(x) : val === x);
  if ('value' in match) return hit(match.value);
  if ('any' in match) return Array.isArray(match.any) && match.any.some(hit);
  if ('except' in match) return Array.isArray(match.except) && !match.except.some(hit);
  return true;
}

function rangeCond(val, range) {
  if (!range) return true;
  if (val == null) return false;
  const comparable = typeof val === 'string' && !Number.isNaN(new Date(val).getTime()) ? new Date(val).getTime() : val;
  const bound = (value) => typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? new Date(value).getTime() : value;
  if (range.gt !== undefined && !(comparable > bound(range.gt))) return false;
  if (range.gte !== undefined && !(comparable >= bound(range.gte))) return false;
  if (range.lt !== undefined && !(comparable < bound(range.lt))) return false;
  if (range.lte !== undefined && !(comparable <= bound(range.lte))) return false;
  return true;
}

function conditionMatches(rec, condition) {
  if (condition?.should) return condition.should.some((candidate) => conditionMatches(rec, candidate));
  if (condition?.must) return condition.must.every((candidate) => conditionMatches(rec, candidate));
  if (condition?.must_not) return condition.must_not.every((candidate) => !conditionMatches(rec, candidate));
  if (condition?.is_empty?.key) {
    const value = field(rec, condition.is_empty.key);
    return value == null || (Array.isArray(value) && value.length === 0);
  }
  const value = field(rec, condition?.key);
  return matchCond(value, condition?.match) && rangeCond(value, condition?.range);
}

// apply the full Qdrant filter (must = all, must_not = none, should = ignored/optional) to a record.
export function matchesFilter(rec, filter) {
  if (!filter) return true;
  for (const c of filter.must || []) if (!conditionMatches(rec, c)) return false;
  for (const c of filter.must_not || []) if (conditionMatches(rec, c)) return false;
  if (filter.should?.length && !filter.should.some((c) => conditionMatches(rec, c))) return false;
  return true;
}

// stored camelCase record → the snake_case payload the recall pipeline consumes (needs memory_id).
export function toPayload(rec) {
  return {
    memory_id: rec.id,
    org_id: rec.orgId,
    user_id: rec.userId ?? null,
    project: rec.project ?? null,
    project_ids: rec.projectIds || [],
    team_id: rec.primaryTeamId ?? rec.teamId ?? null,
    memory_type: rec.memoryType ?? null,
    tags: rec.tags || [],
    content: rec.content,
    is_latest: rec.isLatest !== false,
    layer: rec.layer || 'memory',
    scope: rec.scope ?? null,
    visibility: rec.visibility ?? null,
    created_at: rec.createdAt ?? null,
    document_date: rec.documentDate ?? null,
    valid_from: rec.validFrom ?? null,
    valid_to: rec.validTo ?? null,
    importance_score: Number(rec.importanceScore ?? rec.confidence ?? rec.metadata?.importance_score ?? 0.5),
  };
}

// Drop-in for the Qdrant vector search: recall all-layer candidates from the .amr shard, apply the
// pipeline's filter, return {id, score, payload} exactly like Qdrant. Overscan so post-filtering
// still yields `limit` results.
export function mnemeSearch(store, vector, filter, limit, scoreThreshold = 0) {
  const overscan = Math.max(limit * 8, 64);
  const hits = store.recallLayer(Float32Array.from(vector), overscan, -1); // -1 = all layers
  const out = [];
  for (const h of hits) {
    if (h.score < scoreThreshold) continue;
    let rec;
    try { rec = JSON.parse(h.text); } catch { continue; }
    if (!rec || !rec.id) continue;
    if (!matchesFilter(rec, filter)) continue;
    out.push({ id: rec.id, score: h.score, payload: toPayload(rec) });
    if (out.length >= limit) break;
  }
  return out;
}
