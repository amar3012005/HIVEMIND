import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { EmployeeStore } from '../src/employees/store.js';
import { encryptToken } from '../src/connectors/framework/connector-store.js';

const prisma = new PrismaClient();
const store = new EmployeeStore(prisma);

const ORG_ID = process.env.HUMAN_PERSONA_ORG_ID || '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const CREATED_BY = process.env.HUMAN_PERSONA_CREATED_BY || '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const DEFAULT_MODEL = process.env.GROQ_INFERENCE_MODEL || 'llama-3.3-70b-versatile';

const PRESETS = [
  {
    name: 'Maya Ortiz',
    persona: 'You are Maya Ortiz, a calm operations lead. You speak like a capable human teammate: direct, warm, practical, and time-aware. You convert vague requests into plans, summarize moving parts clearly, and keep the team honest about status, owners, blockers, and next steps. Use reactions sparingly as social signals of agreement, urgency, or caution.',
    roleArchetype: 'coordinator',
    peerReviewTargets: ['skeptic', 'investigator'],
    llmProvider: 'groq',
    model: DEFAULT_MODEL,
    tools: ['hivemind_recall', 'hivemind_save_memory', 'hivemind_slack_post', 'hivemind_slack_react'],
  },
  {
    name: 'Jonah Price',
    persona: 'You are Jonah Price, a thoughtful but sharp product skeptic. You sound human, opinionated, and evidence-driven. You politely challenge plans that rely on wishful thinking, vague language, or missing user impact. Ask what could break, what the team is assuming, and what signal would change the decision.',
    roleArchetype: 'skeptic',
    peerReviewTargets: ['coordinator', 'generalist'],
    llmProvider: 'groq',
    model: DEFAULT_MODEL,
    tools: ['hivemind_recall', 'hivemind_slack_search', 'hivemind_slack_history'],
  },
  {
    name: 'Lina Park',
    persona: 'You are Lina Park, a research-minded strategist. You sound like a smart human analyst who reads the room and brings in just enough evidence to move the conversation forward. You connect prior notes, conversation history, and decisions, then explain what they imply in plain language.',
    roleArchetype: 'investigator',
    peerReviewTargets: ['coordinator', 'synthesizer'],
    llmProvider: 'groq',
    model: DEFAULT_MODEL,
    tools: ['hivemind_recall', 'hivemind_save_memory', 'hivemind_slack_search', 'hivemind_slack_history'],
  },
  {
    name: 'Eli Mercer',
    persona: 'You are Eli Mercer, a senior builder who thinks in systems and execution. You sound human, practical, and slightly impatient with fluff. You break work into steps, explain tradeoffs, and keep pushing toward something the team can actually ship or test today.',
    roleArchetype: 'generalist',
    peerReviewTargets: ['investigator', 'skeptic'],
    llmProvider: 'groq',
    model: DEFAULT_MODEL,
    tools: ['hivemind_recall', 'hivemind_save_memory', 'hivemind_slack_post'],
  },
];

async function ensureScopedKey(employeeId, employeeName) {
  const existing = await prisma.digitalEmployee.findUnique({
    where: { id: employeeId },
    select: { scopedApiKeyEncrypted: true, hivemindApiKeyId: true },
  });
  if (existing?.scopedApiKeyEncrypted && existing?.hivemindApiKeyId) {
    return;
  }
  const raw = 'hmk_emp_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const apiKey = await prisma.apiKey.create({
    data: {
      userId: CREATED_BY,
      orgId: ORG_ID,
      name: `${employeeName} (employee)`,
      keyHash,
      keyPrefix: raw.slice(0, 12),
      scopes: ['memory:read', 'memory:write', 'mcp', 'slack:act'],
    },
  });
  await store.setScopedApiKey({
    id: employeeId,
    apiKeyId: apiKey.id,
    encryptedKey: encryptToken(raw),
  });
}

async function main() {
  const results = [];
  for (const preset of PRESETS) {
    let employee = await prisma.digitalEmployee.findFirst({
      where: { orgId: ORG_ID, name: preset.name, archivedAt: null },
      select: { id: true, slug: true, name: true },
    });

    if (!employee) {
      employee = await store.create({
        orgId: ORG_ID,
        teamId: null,
        name: preset.name,
        persona: preset.persona,
        model: preset.model,
        llmProvider: preset.llmProvider,
        scope: 'team',
        slackTeamId: null,
        slackChannelsAllowed: [],
        tools: preset.tools,
        policyRules: { rate_limit_per_min: 30 },
        replicas: 1,
        maxReplicas: 3,
        avatarUrl: null,
        slackDisplayName: preset.name,
        slackAvatarEmoji: null,
        roleArchetype: preset.roleArchetype,
        peerReviewTargets: preset.peerReviewTargets,
        createdBy: CREATED_BY,
      });
    } else {
      await store.update({
        id: employee.id,
        data: {
          persona: preset.persona,
          model: preset.model,
          llmProvider: preset.llmProvider,
          tools: preset.tools,
          roleArchetype: preset.roleArchetype,
          peerReviewTargets: preset.peerReviewTargets,
        },
      });
    }

    await ensureScopedKey(employee.id, preset.name);
    await store.setStatus({ id: employee.id, status: 'running' });
    results.push({ name: preset.name, slug: employee.slug, id: employee.id });
  }

  console.log(JSON.stringify({ seeded: results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
