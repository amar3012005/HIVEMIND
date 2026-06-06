/**
 * Per-org cognition activation allowlist.
 *
 * The cognitive layer's risky behaviours (scanning personal memories,
 * auto-executing proposals, principle synthesis, retrieval-config evolution)
 * must roll out to ONE pilot org at a time, not globally. This module is the
 * single gate: a behaviour is active for an org only when (a) the org is in the
 * COGNITION_PILOT_ORGS allowlist AND (b) the corresponding global flag is set.
 *
 * Default (no allowlist) → every helper returns false → behaviour is
 * byte-identical to pre-pilot. Turning on a global flag alone does NOT activate
 * anything; the org must also be allowlisted. This prevents an accidental
 * env flip from enabling cognition writes across every tenant at once.
 *
 * Environment:
 *   COGNITION_PILOT_ORGS         csv of org UUIDs cognition is piloted on
 *   COGNITION_INCLUDE_PERSONAL   '=true' → Faraday also scans visibility=personal (pilot orgs only)
 *
 * @module resident/cognition-pilot
 */

/** @returns {Set<string>} the set of pilot org IDs from COGNITION_PILOT_ORGS. */
export function cognitionPilotOrgs() {
  return new Set(
    String(process.env.COGNITION_PILOT_ORGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * @param {string} orgId
 * @returns {boolean} whether this org is in the cognition pilot allowlist.
 */
export function isCognitionPilot(orgId) {
  if (!orgId) return false;
  return cognitionPilotOrgs().has(orgId);
}

/**
 * A global env flag takes effect for an org ONLY when the org is also a pilot.
 * @param {string} orgId
 * @param {string} envName  name of the global boolean env flag
 * @returns {boolean}
 */
export function pilotFlagEnabled(orgId, envName) {
  return isCognitionPilot(orgId) && process.env[envName] === 'true';
}

/**
 * Whether Faraday should scan the org's private memories (visibility='private',
 * i.e. personal/project-scoped) in addition to organization-visible ones.
 * Pilot-gated.
 * @param {string} orgId
 * @returns {boolean}
 */
export function includePersonalForOrg(orgId) {
  return pilotFlagEnabled(orgId, 'COGNITION_INCLUDE_PERSONAL');
}
