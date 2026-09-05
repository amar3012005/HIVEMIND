/** Compact stage skills. Only the active stage is supplied to the planner. */
const SKILLS = Object.freeze({
  intent: 'Return language-neutral requested outcomes. Connected self-data never needs an account-name question. Keep factual identifiers unresolved until evidence supplies them.',
  planning: 'Use Composio’s returned plan, connection state, and schemas. Select only one semantic next action. Resolve factual dependencies before clarification; a mutation is always a draft.',
  arguments: 'Generate only values grounded in explicit user facts or successful receipts. Omit unknown fields. Never invent a destination, identifier, or provider example value.',
  hitl: 'Ask in business language, never raw provider field names. Connection and clarification resume the same run. Every mutation stops at an editable PendingWrite approval.',
  synthesis: 'Answer in the user locale. Lead with the proven outcome. A draft is not sent; failed or missing receipts are not evidence of absence.',
});

export function loadGovernedSkill(stage) {
  const content = SKILLS[stage];
  if (!content) throw new Error(`unknown_governed_skill:${stage}`);
  return { id: `governed/${stage}/v1`, content };
}

export const governedSkillIds = Object.freeze(Object.keys(SKILLS));
