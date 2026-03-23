const MAX_LOG_ENTRIES = 500;
const MAX_CONTEXT_ITEMS = 6;

function getState() {
  if (!globalThis.__hivemindLiveLogState) {
    globalThis.__hivemindLiveLogState = {
      entries: [],
      installedServices: new Set(),
    };
  }
  return globalThis.__hivemindLiveLogState;
}

function truncate(value, max = 400) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function normalizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message),
      stack: truncate(value.stack || '', 900),
    };
  }
  if (depth >= 2) {
    return truncate(JSON.stringify(value));
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONTEXT_ITEMS).map((item) => normalizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_CONTEXT_ITEMS)) {
      result[key] = normalizeValue(nested, depth + 1);
    }
    return result;
  }
  return truncate(String(value));
}

function buildMessage(args) {
  return truncate(args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(normalizeValue(arg));
    } catch {
      return String(arg);
    }
  }).join(' '), 800);
}

function appendEntry(service, level, args) {
  const state = getState();
  const timestamp = new Date().toISOString();
  const context = args
    .filter((arg) => typeof arg !== 'string')
    .slice(0, MAX_CONTEXT_ITEMS)
    .map((arg) => normalizeValue(arg));

  state.entries.push({
    id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    service,
    level,
    message: buildMessage(args),
    context,
  });

  if (state.entries.length > MAX_LOG_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_LOG_ENTRIES);
  }
}

export function installConsoleCapture(service) {
  const state = getState();
  if (state.installedServices.has(service)) {
    return;
  }
  state.installedServices.add(service);

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      appendEntry(service, level, args);
      original(...args);
    };
  }

  process.on('unhandledRejection', (reason) => {
    appendEntry(service, 'error', ['Unhandled rejection', reason]);
  });

  process.on('uncaughtExceptionMonitor', (error) => {
    appendEntry(service, 'error', ['Uncaught exception', error]);
  });
}

export function recordLog(service, level, ...args) {
  appendEntry(service, level, args);
}

export function getRecentLogs({ service, level, search, limit = 200 } = {}) {
  const state = getState();
  let entries = [...state.entries];

  if (service) {
    entries = entries.filter((entry) => entry.service === service);
  }
  if (level) {
    entries = entries.filter((entry) => entry.level === level);
  }
  if (search) {
    const needle = search.toLowerCase();
    entries = entries.filter((entry) => entry.message.toLowerCase().includes(needle));
  }

  return entries.slice(-limit).reverse();
}

export function getLogSummary(service) {
  const entries = getRecentLogs({ service, limit: MAX_LOG_ENTRIES });
  const summary = {
    total: entries.length,
    errors: 0,
    warnings: 0,
    lastErrorAt: null,
    lastWarningAt: null,
  };

  for (const entry of entries) {
    if (entry.level === 'error') {
      summary.errors += 1;
      summary.lastErrorAt ||= entry.timestamp;
    }
    if (entry.level === 'warn') {
      summary.warnings += 1;
      summary.lastWarningAt ||= entry.timestamp;
    }
  }

  return summary;
}
