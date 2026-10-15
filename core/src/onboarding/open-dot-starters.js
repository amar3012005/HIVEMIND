/** Existing onboarding owner -> canonical employee lifecycle -> Dot materialization. */
import { createHash } from 'node:crypto';
import { manageNativeEmployee, lifecycleError } from '../employees/native-lifecycle.js';
import { bindOpenDotEmployee, verifyOpenDotBinding } from '../employees/open-dot-registry.js';

export function starterCreationKey(siteUrl, slot) {
  const site = new URL(siteUrl); site.hash = ''; site.search = '';
  return `hyper-starter:${createHash('sha256').update(site.href).digest('hex')}:${slot}`;
}

export async function provisionOpenDotStarter(db, principal, input, {
  slot, sessionCookie, fetchImpl = fetch,
} = {}) {
  // This option is internal to the predefined company onboarding owner. The
  // public create endpoint does not accept it or a client-supplied ready flag.
  const created = await manageNativeEmployee(db, principal, input, {
    executionBackend: 'open-dot', predefinedStarter: { source: 'hyperagents-onboarding', slot },
  });
  let employee = created.employee;
  const materialize = async () => {
    const response = await fetchImpl('https://dots.singulancelabs.com/api/hivemind/employees/materialize', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Cookie: `hm_cp_session=${encodeURIComponent(sessionCookie)}`,
        Origin: 'https://runtime-runner.singulancelabs.com' },
      body: JSON.stringify({ employee_id: employee.id }),
    });
    if (!response.ok) lifecycleError('starter_employee_materialization_pending', 503);
  };
  if (!sessionCookie) lifecycleError('hive_session_cookie_required', 401);
  await materialize();
  const marker = employee.policyRules.open_dot_employee;
  const proof = await verifyOpenDotBinding({ employeeId: employee.id, creationKey: marker.creation_key,
    principal, sessionCookie, fetchImpl });
  const bound = await bindOpenDotEmployee(db, principal, {
    operation: 'bind', employee_id: employee.id, creation_key: marker.creation_key,
    expected_binding_revision: marker.binding_revision,
  }, { proof });
  employee = bound.employee;
  // Publish the canonical ready mapping before Runtime can dispatch a welcome.
  await materialize();
  return employee;
}
