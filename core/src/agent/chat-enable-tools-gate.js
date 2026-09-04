/**
 * use_tools:false gate: if THIS message needs a connector app, pause for
 * Enable-tools HITL instead of calling Composio. Detection only — no I/O.
 */
import { appsMatchingRequest, displayAppName, writeToolkitsIn } from './durable-composio-agent.js';

const NATIVE_ONLY = new Set(['hivemind']);

export function destinationAppsForEnableTools(message) {
  const raw = String(message || '');
  const extras = [];
  if (/\binstagram\b|\binsta\b/i.test(raw)) extras.push('instagram');
  if (/\boutlook\b/i.test(raw)) extras.push('outlook');
  const named = appsMatchingRequest(raw, extras).filter((toolkit) => {
    if (toolkit === 'github') return /\bgithub\b/i.test(raw);
    if (toolkit === 'gmail') {
      return /\b(gmail|outlook)\b/i.test(raw) || writeToolkitsIn(raw, extras).includes('gmail');
    }
    return true;
  });
  const writes = writeToolkitsIn(raw, [...named, ...extras]);
  return [...new Set([...named, ...writes, ...extras])]
    .map((toolkit) => String(toolkit || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((toolkit) => toolkit && !NATIVE_ONLY.has(toolkit));
}

export function enableToolsRequest(toolkits = []) {
  const apps = [...new Set((toolkits || []).filter(Boolean))];
  const labels = apps.map(displayAppName);
  const listed = labels.length
    ? labels.join(', ').replace(/, ([^,]*)$/, ' or $1')
    : 'connected apps';
  return {
    kind: 'enable_tools',
    field: 'use_tools',
    blocking: true,
    toolkits: apps,
    prompt: `This request needs ${listed}. Enable tools for this request and I will continue the same query (drafts stay for your approval — nothing is sent live).`,
    options: [
      { id: 'enable', label: 'Enable tools and continue', value: 'enable' },
      { id: 'decline', label: 'Not now — answer here only', value: 'decline' },
    ],
  };
}
