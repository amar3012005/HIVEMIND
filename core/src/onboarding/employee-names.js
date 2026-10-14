import { STARTER_EMPLOYEES } from './starter-employees.js';

// Starter character identity is fixed; domain professions remain company-specific.
export function nameOnboardingTeam(hires, existing = []) {
  const used = new Set((Array.isArray(existing) ? existing : []).map(employee => employee.name));
  const available = STARTER_EMPLOYEES.filter(employee => !used.has(employee.name));
  return hires.slice(0, available.length).map((hire, index) => ({ ...hire, name: available[index].name }));
}
