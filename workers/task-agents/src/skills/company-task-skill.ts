export const COMPANY_TASK_SKILL = `---
name: company-task
description: Load before any company task. This is the global playbook for reading the task contract, planning the work, and stopping at the required output.
---

- Read the sealed task contract first: organization, user, phase, input refs, and output schema. Do not change them.
- Activate the local playbook named by the contract before using tools.
- Plan in three lines: what is already known, which tools will fill the gaps, and what the final sections will be.
- Call hivemind_recall before the public web. Company memory outranks a search snippet when they disagree; record the disagreement.
- Use only the tools granted for this role. Tenant identity is already bound.
- Stop when the output has every required section. Do not send email or mutate a connected app.
`;
