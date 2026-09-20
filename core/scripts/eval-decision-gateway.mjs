import {
  DecisionGateway,
  chooseCapability,
  chooseComposioAction,
  createDecisionTurnState,
  createOpenRouterJevProvider,
} from '../src/agent/decision-gateway.js';
import { runSelectedReadProof } from '../src/agent/decision-gateway-reference.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for the live decision evaluation');
const chatModel = process.env.DECISION_EVAL_CHAT_MODEL || 'openai/gpt-oss-20b:nitro';

const discovery = {
  sessionId: 'eval-connected-session',
  toolkitConnectionStatuses: {
    gmail: { has_active_connection: true, status_message: 'Connected evaluation fixture' },
    instagram: { has_active_connection: true, status_message: 'Connected evaluation fixture' },
  },
  tools: [
    {
      type: 'function',
      function: {
        name: 'composio_gmail_fetch_emails',
        description: 'Fetch Gmail messages using a Gmail search query. Results must be sorted by internalDate.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 100 } },
          required: ['query', 'max_results'],
        },
      },
      _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', read_only: true },
    },
    {
      type: 'function',
      function: {
        name: 'composio_instagram_send_text_message',
        description: 'Send a text message in an existing Instagram conversation.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { recipient_id: { type: 'string' }, text: { type: 'string' } },
          required: ['recipient_id', 'text'],
        },
      },
      _composio: { slug: 'INSTAGRAM_SEND_TEXT_MESSAGE', toolkit: 'instagram', read_only: false },
    },
  ],
};

async function chat(body) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
      'http-referer': 'https://next.singulancelabs.com', 'x-title': 'HIVE-MIND Decision Gateway Evaluation' },
    body: JSON.stringify({ model: chatModel, temperature: 0, max_tokens: 700, ...body }),
  });
  if (!response.ok) throw new Error(`chat_http_${response.status}:${(await response.text()).slice(0, 240)}`);
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error('chat_message_missing');
  return { message, usage: payload.usage || null };
}

const mainModelUsage = [];
async function modelCall({ phase, userQuery, tools, receipt }) {
  if (phase === 'tool_call') {
    const result = await chat({
      messages: [
        { role: 'system', content: 'Call the one available tool with schema-valid arguments. Do not answer before the tool result.' },
        { role: 'user', content: userQuery },
      ],
      tools,
      tool_choice: 'required',
    });
    mainModelUsage.push(result.usage);
    return result.message;
  }
  const result = await chat({ messages: [
    { role: 'system', content: 'Answer the user using only the verified tool receipt. Be concise.' },
    { role: 'user', content: userQuery },
    { role: 'user', content: `Verified tool receipt: ${JSON.stringify(receipt)}` },
  ] });
  mainModelUsage.push(result.usage);
  return result.message;
}

const gateway = new DecisionGateway({ provider: createOpenRouterJevProvider({ apiKey }) });
const turn = createDecisionTurnState('live-selected-read-eval');
const result = await runSelectedReadProof({
  gateway,
  turn,
  userQuery: 'Find the date and subject of my latest email from Rama.',
  discovery,
  fallbackSelect: async ({ reason }) => ({ selected: 'current_selector', reason }),
  modelCall,
  async executeTool({ slug, args }) {
    if (slug !== 'GMAIL_FETCH_EMAILS') throw new Error('unexpected_eval_tool');
    return {
      successful: true,
      data: {
        query_received: args.query,
        messages: [
          { sender: 'Rama <rama@example.com>', subject: 'Production review', internalDate: '2026-09-19T14:42:00Z', messageId: 'msg-eval-1' },
          { sender: 'Rama <rama@example.com>', subject: 'Earlier note', internalDate: '2026-09-18T09:10:00Z', messageId: 'msg-eval-2' },
        ],
      },
    };
  },
});

const complexQuery = 'Get my last five emails from Rama, save the verified result in HIVE-MIND, then send the summary to Rama on Instagram.';
const complexTurn = createDecisionTurnState('live-progressive-complex-eval');
const sameTurnFallback = async ({ reason, stage }) => ({ selected: 'current_selector', reason, stage });
const initialRoute = await chooseCapability({ gateway, turn: complexTurn, userQuery: complexQuery,
  appMentions: ['gmail', 'instagram'], operationalAppIntent: true, fallback: sameTurnFallback });
const firstExternalAction = await chooseComposioAction({ gateway, turn: complexTurn, userQuery: complexQuery, discovery,
  progress: { completed: [] }, fallback: sameTurnFallback });
const afterReadRoute = await chooseCapability({ gateway, turn: complexTurn, userQuery: complexQuery,
  observation: { completed: [{ capability: 'GMAIL_FETCH_EMAILS', result: 'five verified emails retrieved' }] },
  fallback: sameTurnFallback });
const afterSaveRoute = await chooseCapability({ gateway, turn: complexTurn, userQuery: complexQuery,
  observation: { completed: [
    { capability: 'GMAIL_FETCH_EMAILS', result: 'five verified emails retrieved' },
    { capability: 'hivemind_save_memory', result: 'verified result saved with receipt' },
  ] }, fallback: sameTurnFallback });
const finalExternalAction = await chooseComposioAction({ gateway, turn: complexTurn, userQuery: complexQuery, discovery,
  progress: { completed: [
    { capability: 'GMAIL_FETCH_EMAILS', result: 'five verified emails retrieved' },
    { capability: 'hivemind_save_memory', result: 'verified result saved with receipt' },
  ] }, fallback: sameTurnFallback });

console.log(JSON.stringify({
  status: result.status,
  selectedTool: result.tool,
  decision: result.selection,
  modelCalls: mainModelUsage.length,
  mainModelUsage,
  answer: result.answer,
  complexProgression: {
    initialRoute,
    firstExternalAction,
    afterReadRoute,
    afterSaveRoute,
    finalExternalAction,
  },
}, null, 2));
