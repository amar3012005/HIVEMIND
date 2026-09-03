/**
 * Fail-closed gate for unified native+Composio DAG orchestration.
 * Unset or any value other than the string "true" keeps the legacy
 * connected-only use_tools path.
 */
export const USE_TOOLS_UNIFIED_DAG_FLAG = 'USE_TOOLS_UNIFIED_DAG';

export function isUseToolsUnifiedDagEnabled(env = process.env) {
  return String(env?.USE_TOOLS_UNIFIED_DAG || '').trim() === 'true';
}
