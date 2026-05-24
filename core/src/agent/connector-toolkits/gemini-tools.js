/**
 * Gemini tool group — 1 tool: generative query against Google Gemini.
 * Inactive by default. Activated via reset_equipped_tools.
 *
 * Use case: agent needs a SECOND-OPINION answer or current-knowledge
 * lookup (Gemini has different training data than the primary OSS model).
 * Output is auto-logged as a Gemini session memory via the canonical
 * pipeline so future recall surfaces what Gemini said.
 */

import { nangoProxyFetch } from './nango-fetch.js';

const GEMINI_PROVIDER = 'google-gemini';
// Gemini API endpoint via Nango. Nango passes the OAuth token; the user's
// own Gemini project is used so usage bills the user, not HIVEMIND.
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

const SKILL_NOTES = [
  'GEMINI TOOL — direct Google Gemini call for second-opinion answers.',
  '  • gemini_query(prompt, model?) — single-turn generation. Returns text reply.',
  'Use this when the user wants Gemini specifically OR when cross-model verification adds value.',
  'Result is auto-saved as a Gemini session memory so the conversation lands in HIVEMIND graph.',
].join('\n');

export function registerGeminiTools(toolkit, { persistentMemoryEngine } = {}) {
  toolkit.createToolGroup({
    name: 'google-gemini',
    description: 'Google Gemini direct query tool (Nango-routed).',
    active: false,
    notes: SKILL_NOTES,
  });

  toolkit.registerToolFunction({
    name: 'gemini_query',
    description: 'Send a single-turn prompt to Google Gemini. Returns the model\'s reply as text. Useful for cross-model second-opinion or when the user explicitly asks Gemini.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send.' },
        model: { type: 'string', description: 'Gemini model id (default gemini-2.0-flash). Options: gemini-2.0-flash, gemini-2.0-pro, gemini-1.5-pro.' },
      },
      required: ['prompt'],
    },
    groupName: 'google-gemini',
    readOnly: false, // not destructive but consumes user's Gemini API budget
    handler: async (args, ctx) => {
      const model = args.model || 'gemini-2.0-flash';
      const url = `${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`;
      const data = await nangoProxyFetch({
        providerKey: GEMINI_PROVIDER, url, method: 'POST',
        body: {
          contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
        },
        ctx,
      });
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '')
        .join('')
        .trim();

      // Side-effect: auto-log as Gemini memory so the conversation lands in the
      // graph. Fire-and-forget — never fails the tool call on ingest error.
      if (persistentMemoryEngine && ctx?.userId) {
        const { GeminiAdapter } = await import('../../connectors/providers/gemini/adapter.js');
        const adapter = new GeminiAdapter();
        const payloads = adapter.normalize({
          session_id: `gemini-tool-${Date.now()}`,
          title: `Gemini query: ${args.prompt.slice(0, 50)}`,
          model,
          turns: [
            { role: 'user', content: args.prompt },
            { role: 'assistant', content: text },
          ],
        }, { user_id: ctx.userId, org_id: ctx.orgId });
        for (const p of payloads) {
          if (p?._tree?.parent) {
            persistentMemoryEngine.ingestMemoryTree(p._tree).catch(e =>
              console.warn('[gemini-tool] auto-save failed:', e.message)
            );
          }
        }
      }

      return { model, reply: text, usage: data?.usageMetadata || null };
    },
  });
}
