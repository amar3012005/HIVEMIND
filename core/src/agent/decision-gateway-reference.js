import { chooseComposioAction, projectComposioDiscovery } from './decision-gateway.js';

function parseToolCall(call) {
  const name = String(call?.function?.name || '').replace(/^composio_/i, '').toUpperCase();
  let args;
  try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { throw new Error('selected_tool_arguments_invalid_json'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('selected_tool_arguments_invalid');
  return { name, args, id: String(call?.id || 'selected-tool-call') };
}
/**
 * Reference proof for one selected read action. The chat model only sees the
 * schema Jev selected, calls that tool, then receives its bounded receipt to
 * produce the answer. Production runtimes keep their own native agent loops.
 */
export async function runSelectedReadProof({ gateway, turn, userQuery, context, discovery,
  fallbackSelect, modelCall, executeTool, signal }) {
  const selection = await chooseComposioAction({ gateway, turn, userQuery, context, discovery,
    fallback: fallbackSelect, signal });
  if (selection.source !== 'jev' || !selection.choice.startsWith('use:')) return { status: 'deferred', selection };
  const slug = selection.choice.slice(4);
  const projection = projectComposioDiscovery(discovery);
  const selected = projection.tools.find(tool => tool.slug === slug);
  if (!selected) throw new Error('selected_tool_not_found');
  if (selected.authority !== 'read') return { status: 'approval_required', selection, tool: slug };
  const first = await modelCall({ phase: 'tool_call', userQuery, tools: [selected.original], context });
  const calls = first?.tool_calls || first?.message?.tool_calls || [];
  if (calls.length !== 1) throw new Error('selected_read_requires_one_tool_call');
  const call = parseToolCall(calls[0]);
  if (call.name !== slug.toUpperCase()) throw new Error('model_called_unselected_tool');
  const receipt = await executeTool({ slug, args: call.args, signal });
  const final = await modelCall({ phase: 'answer', userQuery, tools: [], context, receipt: {
    successful: receipt?.successful !== false,
    data: receipt?.data ?? receipt,
    error: receipt?.successful === false ? String(receipt.error || 'tool_failed').slice(0, 300) : null,
  } });
  return { status: 'completed', selection, tool: slug, receipt, answer: final?.content || final?.message?.content || '' };
}
