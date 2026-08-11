const TERMINAL = new Set([
  'completed', 'done', 'ok', 'success',
  'error', 'failed', 'needs_input', 'draft_created',
  'blocked', 'blocked_pending',
]);

function cleanTool(value) {
  return String(value || '').replace(/^composio_/, '').replace(/^hivemind_/, '').replace(/_/g, ' ').trim();
}

export function slackStageFromAgentEvent(event = {}) {
  const type = String(event.type || '');
  if (type === 'turn_accepted') return { key: 'understand', label: 'Understanding your request', status: 'completed', icon: '🧠' };
  if (type === 'intent_decided' || type === 'orchestration_plan') return { key: 'plan', label: 'Planning the work', status: 'completed', icon: '✨' };
  if (type === 'query_optimized') return { key: 'query', label: 'Optimizing the memory search', status: 'completed', icon: '🔎' };
  if (type === 'coverage_assessed') return { key: 'coverage', label: 'Checking evidence coverage', status: 'completed', icon: '📚' };
  if (type === 'finish') return { key: 'answer', label: 'Writing the response', status: 'completed', icon: '✍️' };

  if (type === 'orchestration_step') {
    const label = cleanTool(event.tool) || String(event.label || event.operation || 'Running a step');
    return {
      key: event.step_id || `compound:${event.index ?? label}`,
      label,
      detail: event.detail || null,
      status: event.phase || 'started',
      icon: connectorIcon(event.tool_groups?.[0] || event.tool || ''),
    };
  }

  if (['tool_selected', 'tool_started', 'tool_call', 'tool_completed', 'tool_result'].includes(type)) {
    const name = event.name || event.tool || event.tool_name || '';
    if (!name) return null;
    const terminal = ['tool_completed', 'tool_result'].includes(type);
    return {
      key: `tool:${String(name).toLowerCase()}`,
      label: toolLabel(name),
      detail: terminal ? (event.summary || event.result_summary || null) : null,
      status: terminal ? (event.status || 'completed') : 'started',
      icon: connectorIcon(name),
    };
  }
  return null;
}

function connectorIcon(value) {
  const name = String(value || '').toLowerCase();
  if (name.includes('gmail')) return '📧';
  if (name.includes('slack')) return '💬';
  if (name.includes('calendar')) return '📅';
  if (name.includes('doc')) return '📄';
  if (name.includes('recall') || name.includes('memory')) return '🧠';
  if (name.includes('web') || name.includes('search')) return '🔎';
  return '⚙️';
}

function toolLabel(name) {
  const cleaned = cleanTool(name);
  if (/\brecall\b/i.test(cleaned)) return 'Recalling relevant memory';
  if (/\bsave memory\b/i.test(cleaned)) return 'Preparing a memory';
  return cleaned ? `Using ${cleaned}` : 'Using a tool';
}

export function mergeSlackStage(stages, stage, maxStages = 8) {
  if (!stage) return stages;
  const next = [...stages];
  const index = next.findIndex((item) => item.key === stage.key);
  if (index >= 0) next[index] = { ...next[index], ...stage };
  else next.push(stage);
  return next.slice(-maxStages);
}

export function renderSlackProgress(stages = []) {
  const rows = stages.map((stage) => {
    const status = String(stage.status || 'started');
    const marker = TERMINAL.has(status)
      ? (['error', 'failed'].includes(status) ? '⚠' : status === 'needs_input' ? '•' : '✓')
      : '◌';
    const detail = stage.detail && !['completed', 'done'].includes(String(stage.detail).toLowerCase())
      ? ` — ${String(stage.detail).slice(0, 140)}` : '';
    return `${marker} ${stage.icon || '⚙️'} ${stage.label}${detail}`;
  });
  return ['🧠 *Working through your request…*', ...rows].join('\n');
}

export function createSlackProgressReporter({ update, minIntervalMs = 900, maxStages = 8 }) {
  let stages = [];
  let timer = null;
  let lastSentAt = 0;
  let stopped = false;
  let chain = Promise.resolve();

  const send = () => {
    if (stopped || !stages.length) return;
    lastSentAt = Date.now();
    const text = renderSlackProgress(stages);
    chain = chain.then(() => update(text)).catch(() => {});
  };
  const schedule = () => {
    if (stopped || timer) return;
    const wait = Math.max(0, minIntervalMs - (Date.now() - lastSentAt));
    if (wait === 0) send();
    else timer = setTimeout(() => { timer = null; send(); }, wait);
  };
  return {
    onEvent(event) {
      const stage = slackStageFromAgentEvent(event);
      if (!stage || stopped) return;
      stages = mergeSlackStage(stages, stage, maxStages);
      schedule();
    },
    async stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!stopped && stages.length && Date.now() - lastSentAt >= minIntervalMs / 2) send();
      stopped = true;
      await chain;
    },
    snapshot() { return [...stages]; },
  };
}
