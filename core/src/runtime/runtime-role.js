const ROLE = (process.env.HIVEMIND_RUNTIME_ROLE || 'all').trim().toLowerCase();
const ENGINE_BOX_MODE = ['true', '1'].includes(String(process.env.ENGINE_BOX_MODE || '').toLowerCase());

export function getRuntimeRole() {
  return ROLE || 'all';
}

export function isAppRuntime() {
  return ROLE === 'app';
}

export function isSidecarRuntime() {
  return ROLE === 'sidecar';
}

export function isMaintenanceRuntime() {
  return ROLE === 'maintenance';
}

export function isAllInOneRuntime() {
  return ROLE === 'all';
}

export function shouldStartHttpServer() {
  return isAllInOneRuntime() || isAppRuntime();
}

export function shouldRunRecurringMaintenanceJobs() {
  if (ENGINE_BOX_MODE) return false;
  return isAllInOneRuntime() || isMaintenanceRuntime();
}

export function shouldRunConnectorBackground() {
  if (ENGINE_BOX_MODE) return false;
  return isAllInOneRuntime() || isAppRuntime();
}

export function shouldRunWarmupsAndSidecars() {
  if (ENGINE_BOX_MODE) return false;
  return isAllInOneRuntime() || isSidecarRuntime();
}
