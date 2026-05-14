/**
 * Vercel AI SDK + HIVEMIND tool — Claude (or any model) reaches your company brain.
 *
 * Install:
 *   npm i @hivemind/sdk ai @ai-sdk/anthropic zod
 *
 * Run:
 *   HIVEMIND_API_KEY=hmk_live_...  ANTHROPIC_API_KEY=sk-ant-...  npx tsx vercel-ai-sdk.ts
 */

import { anthropic } from '@ai-sdk/anthropic';
import { HiveMindClient } from '@hivemind/sdk';
import { hivemindTool } from '@hivemind/sdk/integrations/vercel-ai-sdk';
import { generateText } from 'ai';

const hm = new HiveMindClient({
  url: 'https://core.hivemind.davinciai.eu:8050',
  apiKey: process.env.HIVEMIND_API_KEY!,
});

const { text, toolCalls } = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    hivemind_search: hivemindTool(hm, { scope: 'team', defaultK: 5 }),
  },
  prompt: 'What did we decide about EU AI Act compliance? Cite sources.',
  maxSteps: 5,
});

console.log(text);
console.log('Tool calls:', toolCalls.length);
