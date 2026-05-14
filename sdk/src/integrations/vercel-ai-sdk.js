/**
 * Vercel AI SDK tool wrapper for HIVEMIND.
 *
 * Drop into any `generateText`/`streamText`/`tool({...})` call so Claude/GPT
 * can search your company brain mid-conversation.
 *
 * @example
 *   import { generateText } from 'ai';
 *   import { anthropic } from '@ai-sdk/anthropic';
 *   import { HiveMindClient } from '@hivemind/sdk';
 *   import { hivemindTool } from '@hivemind/sdk/integrations/vercel-ai-sdk';
 *
 *   const hm = new HiveMindClient({ url: '...', apiKey: 'hmk_live_...' });
 *
 *   const { text } = await generateText({
 *     model: anthropic('claude-sonnet-4-5'),
 *     tools: { hivemind_search: hivemindTool(hm, { scope: 'team' }) },
 *     prompt: 'What did we decide about EU AI Act compliance?',
 *   });
 */

import { z } from 'zod';

/**
 * @param {import('../index.js').HiveMindClient} client
 * @param {{ scope?: 'personal'|'team'|'all', defaultK?: number, projectFilter?: string }} options
 */
export function hivemindTool(client, options = {}) {
  const scope = options.scope || 'team';
  const defaultK = options.defaultK || 5;
  const projectFilter = options.projectFilter;

  return {
    description:
      'Search HIVEMIND company memory for relevant context. Returns ranked memories ' +
      'with provenance (source id, score, cluster). Use this BEFORE answering any ' +
      'question about company knowledge, internal decisions, team conversations, ' +
      'customer data, or historical context. Cite the source memory id in your final answer.',
    parameters: z.object({
      query: z.string().describe('Natural-language search query. Be specific.'),
      n_results: z.number().int().min(1).max(20).optional().describe('How many results (1-20).'),
      tags: z.array(z.string()).optional().describe('Optional tag filter.'),
    }),
    execute: async ({ query, n_results, tags }) => {
      const results = await client.search(query, {
        n_results: n_results || defaultK,
        scope,
        tags,
        project: projectFilter,
      });
      const citations = (results || []).map((r) => ({
        source: r.memory?.id || r.id,
        title: r.memory?.title || r.title,
        content: r.memory?.content || r.content,
        score: typeof r.score === 'number' ? Number(r.score.toFixed(4)) : r.score,
        method: r.method || 'hybrid',
        tags: r.memory?.tags || r.tags,
      }));
      return {
        query,
        n_results: citations.length,
        results: citations,
        instruction:
          'Use these results to answer. Cite memory IDs as [source: <id>]. ' +
          'If no result is relevant enough, say so explicitly — do not hallucinate.',
      };
    },
  };
}

export default hivemindTool;
