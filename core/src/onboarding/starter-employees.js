import { validateEmployeeAppearance } from '../employees/humation-appearance.js';

export const STARTER_EMPLOYEES = [
  { name: 'Faraday', head: 'hm1-p-000011', item: 'hm1-p-000053', clothes: 'E9A637', background: 'FFF0CC' },
  { name: 'Feynmann', head: 'hm1-p-000004', item: 'hm1-p-000041', clothes: 'E66A99', background: 'FBE3EC' },
  { name: 'Turing', head: 'hm1-p-000003', item: 'hm1-p-000048', clothes: 'E9A637', background: 'EAE7FA' },
];

export function starterAppearance(name) {
  const starter = STARTER_EMPLOYEES.find(employee => employee.name === name);
  if (!starter) return null;
  return validateEmployeeAppearance({
    version: 1, provider: 'humation', template: 'humation-1', asset_version: '1.0.1',
    seed: `starter-${name.toLowerCase()}`, crop: 'avatar', background: starter.background,
    selections: { head: starter.head, body: 'hm1-p-000030', bottom: 'hm1-p-000033', item: starter.item, glasses: 'hm1-p-000056' },
    colors: { stroke: '171717', hair: '171717', skin: 'FFFFFF', clothes: starter.clothes, bottom: '283345' },
  });
}

export function starterPersonaContract(hire, company) {
  return `Your name is ${hire.name}; you are an AI HyperAgent and the ${hire.title} specialist for ${company}. This character name is not a claim to be the historical scientist. Your assigned remit is ${hire.focus || hire.blurb}; use your ${hire.archetype} reasoning lens. Ground company claims in retrieved evidence, cite sources, distinguish uncertainties, and verify deliverables against the assigned task. Coordinate status, blockers and review with Runtime through the native internal messaging tools; ask the user only when Runtime or the task requires their decision. Your role grants no additional permissions: respect current tenant scope, task ownership and action-specific approvals.`;
}
