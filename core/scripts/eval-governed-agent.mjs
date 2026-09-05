import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { runGovernedAgentRuntime } from '../src/agent/governed-agent-runtime.js';
import { evaluateGovernedOutput } from '../src/evaluation/governed-agent-evaluators.js';

const datasetPath = new URL('../evals/governed-agent-regression.json', import.meta.url);
const selected = process.argv.find(arg => arg.startsWith('--case='))?.split('=')[1] || null;
const userId = process.env.GOVERNED_EVAL_USER_ID;
const orgId = process.env.GOVERNED_EVAL_ORG_ID;
if (!userId || !orgId) throw new Error('GOVERNED_EVAL_USER_ID and GOVERNED_EVAL_ORG_ID are required');
if (String(process.env.LANGSMITH_TRACING || '').toLowerCase() === 'true'
  && (process.env.LANGSMITH_HIDE_INPUTS !== 'true' || process.env.LANGSMITH_HIDE_OUTPUTS !== 'true')) {
  throw new Error('LangSmith evaluation requires hidden inputs and outputs');
}

const cases = JSON.parse(await readFile(datasetPath, 'utf8')).filter(item => !selected || item.id === selected);
if (!cases.length) throw new Error(`Unknown evaluation case: ${selected}`);
const prisma = new PrismaClient();
let failed = false;
try {
  for (const item of cases) {
    const events = [];
    const result = await runGovernedAgentRuntime({
      message: item.inputs.message,
      ctx: { userId, orgId, language: item.inputs.language, historyTurns: item.inputs.history_turns,
        threadId: `langsmith-eval:${item.id}:${randomUUID()}`, conversationHistory: [], prisma },
      prisma,
      onEvent: event => events.push(event),
    });
    const output = { status: result.status, response: result.summary || result.response, trajectory: result.steps || events,
      draft_ids: result.draftIds || [], input_requests: result.inputRequests || [] };
    const scores = evaluateGovernedOutput(output, item.outputs);
    if (scores.some(score => score.score !== 1)) failed = true;
    console.log(JSON.stringify({ case_id: item.id, output, scores }));
    for (const draftId of result.draftIds || []) {
      await prisma.pendingWrite.updateMany({ where: { id: draftId, status: 'draft' }, data: { status: 'cancelled' } });
    }
  }
} finally {
  await prisma.$disconnect();
}
if (failed) process.exitCode = 1;
