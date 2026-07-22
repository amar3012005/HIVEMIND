// Connector Runtime V1 — policy engine (plan §4 steps 5,6,7,10).
//
// The authorize hook enforces, in order:
//   - surface permission (tool.allowedSurfaces) — also enforced in the spine
//   - role floor (tool.minimumRole vs ctx.role)
//   - access policy (a read-only surface/context cannot invoke a write tool)
// Capability-token verification (remote surfaces) is added in Phase 5 and
// plugged as an additional authorize step — this engine stays the in-process
// authority.
//
// Language- and tenant-neutral: role comparison is by a fixed rank table, not
// locale; no provider names hard-coded.

import { ForbiddenError } from './errors.js';

// Role rank: higher = more privilege. Unknown roles rank 0 (least privilege).
const ROLE_RANK = Object.freeze({ viewer: 1, member: 2, manager: 3, admin: 4, owner: 5 });
const rank = (r) => ROLE_RANK[String(r || '').toLowerCase()] || 0;

/**
 * Build an authorize hook. `opts.readOnlySurfaces` may force a set of surfaces
 * to reads only (e.g. TARA voice); defaults to none (surfaces decide per-tool).
 */
export function makePolicyEngine(opts = {}) {
  const readOnlySurfaces = new Set(opts.readOnlySurfaces || []);
  return async function authorize({ tool, context }) {
    // role floor
    if (tool.minimumRole && rank(context.role) < rank(tool.minimumRole)) {
      throw new ForbiddenError(`tool "${tool.name}" requires role ${tool.minimumRole}`);
    }
    // a read-only surface can never invoke a write
    if (readOnlySurfaces.has(context.surface) && tool.access === 'write') {
      throw new ForbiddenError(`surface "${context.surface}" is read-only; "${tool.name}" is a write`);
    }
    // explicit read-only context flag (e.g. a room agent granted read scope)
    if (context.readOnly === true && tool.access === 'write') {
      throw new ForbiddenError(`this context is read-only; "${tool.name}" is a write`);
    }
  };
}
