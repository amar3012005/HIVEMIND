const ROLE = (process.env.HIVEMIND_RUNTIME_ROLE || 'all').trim().toLowerCase();

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
  return isAllInOneRuntime() || isMaintenanceRuntime();
}

export function shouldRunConnectorBackground() {
  return isAllInOneRuntime() || isAppRuntime();
}

export function shouldRunWarmupsAndSidecars() {
  return isAllInOneRuntime() || isSidecarRuntime();
}
