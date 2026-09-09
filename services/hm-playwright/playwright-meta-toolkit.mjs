const TOOL_CATALOG = Object.freeze([
  ['browser_close', 'session', 'browse', 'Close the browser'],
  ['browser_resize', 'session', 'browse', 'Resize the browser window'],
  ['browser_console_messages', 'inspect', 'read', 'Read browser console messages'],
  ['browser_handle_dialog', 'interact', 'write', 'Accept or dismiss a browser dialog'],
  ['browser_evaluate', 'advanced', 'unsafe', 'Evaluate JavaScript in the page'],
  ['browser_file_upload', 'interact', 'write', 'Upload one or more files'],
  ['browser_drop', 'interact', 'write', 'Drop files or data onto an element'],
  ['browser_find', 'inspect', 'read', 'Find matching content or elements'],
  ['browser_fill_form', 'interact', 'write', 'Fill multiple form fields'],
  ['browser_press_key', 'interact', 'write', 'Press a keyboard key'],
  ['browser_type', 'interact', 'write', 'Type text into an element'],
  ['browser_navigate', 'navigate', 'browse', 'Navigate to a URL'],
  ['browser_navigate_back', 'navigate', 'browse', 'Go back in browser history'],
  ['browser_network_requests', 'inspect', 'read', 'List recorded network requests'],
  ['browser_network_request', 'inspect', 'read', 'Read one recorded network request'],
  ['browser_run_code_unsafe', 'advanced', 'unsafe', 'Run arbitrary Playwright code'],
  ['browser_take_screenshot', 'capture', 'read', 'Capture a screenshot'],
  ['browser_snapshot', 'capture', 'read', 'Capture an accessibility snapshot'],
  ['browser_click', 'interact', 'write', 'Click an element'],
  ['browser_drag', 'interact', 'write', 'Drag between elements'],
  ['browser_hover', 'interact', 'browse', 'Hover over an element'],
  ['browser_select_option', 'interact', 'write', 'Select an option'],
  ['browser_tabs', 'session', 'browse', 'List, create, select, or close tabs'],
  ['browser_wait_for', 'inspect', 'read', 'Wait for content, disappearance, or time'],
].map(([name, family, risk, description]) => Object.freeze({ name, family, risk, description })));

const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool]));

export const META_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'browser_capabilities',
    description: 'Find the smallest relevant Playwright capability set for a browser task. Call this before browser_execute; follow the returned ordered plan exactly and do not invent browser actions or scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What the user wants to do in the browser.' },
        family: { type: 'string', enum: ['navigate', 'inspect', 'capture', 'interact', 'session', 'advanced'] },
      },
      required: ['intent'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }),
  Object.freeze({
    name: 'browser_execute',
    description: 'Execute one certified Playwright capability returned by the most recent browser_capabilities result. Use only an exact returned action; never substitute a script, guessed browser action, or unlisted interaction. Unsafe code tools are never available.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Exact browser_* action returned by browser_capabilities.' },
        arguments: { type: 'object', description: 'Arguments for the selected action.' },
      },
      required: ['action', 'arguments'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }),
]);

function words(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_]+/g) || []);
}

function relevance(tool, intentWords) {
  let score = 0;
  for (const word of words(`${tool.name} ${tool.family} ${tool.description}`)) {
    if (intentWords.has(word)) score += 1;
  }
  return score;
}

/**
 * A capture is meaningful only after the relevant page has been selected.
 * Keep the current-page case compact, but advertise navigation as an explicit
 * prerequisite for a page capture so a meta-tool client cannot silently
 * screenshot its initial blank page.
 */
function captureNeedsNavigation(intent, family) {
  if (family !== 'capture') return false;
  const request = String(intent || '');
  // An explicit absolute URL is an unambiguous page-selection instruction.
  // It must take precedence over wording such as "current page" in requests
  // like "Open https://example.com and capture the current page".
  if (/\bhttps?:\/\/[^\s/$.?#][^\s]*/i.test(request)) return true;
  return !/\b(?:this|current|already[-\s]?open)\s+page\b/i.test(request);
}

/**
 * When the request asks the browser to establish a fact, a screenshot alone
 * is not evidence for the response. Put the structured page inspection ahead
 * of the visual artifact so the caller can ground its answer in the rendered
 * page, while leaving a simple "capture this page" request lightweight.
 */
function captureNeedsInspection(intent, family) {
  if (family !== 'capture') return false;
  // A request to capture the already selected page has no discovery phase.
  // Treating the word "current" as a fact query would add an unnecessary
  // snapshot and encourage the caller to keep browsing after the image exists.
  if (/\b(?:this|current|already[-\s]?open)\s+page\b/i.test(String(intent || ''))) return false;
  return /\b(?:find|identify|latest|newest|current|which|what|read|extract|details?|information)\b/i.test(String(intent || ''));
}

function orderedCaptureCapabilities(capabilities, { intent, family }) {
  if (family !== 'capture') return capabilities;
  const byName = new Map(capabilities.map((tool) => [tool.name, tool]));
  const ordered = [];
  if (captureNeedsNavigation(intent, family)) ordered.push('browser_navigate');
  if (captureNeedsInspection(intent, family)) ordered.push('browser_snapshot');
  ordered.push('browser_take_screenshot');

  const planned = ordered.map((name) => byName.get(name)).filter(Boolean);
  const remaining = capabilities.filter((tool) => !planned.includes(tool));
  return [...planned, ...remaining].slice(0, 8);
}

export function searchBrowserCapabilities({ intent, family, mode = 'read' } = {}) {
  const intentWords = words(intent);
  const selected = TOOL_CATALOG
    .filter((tool) => tool.risk !== 'unsafe')
    .filter((tool) => mode === 'interactive' || tool.risk !== 'write')
    .filter((tool) => !family || tool.family === family)
    .map((tool) => ({ ...tool, score: relevance(tool, intentWords) }))
    .filter((tool) => tool.score > 0 || family)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(({ score: _score, ...tool }) => tool);

  const navigate = CATALOG_BY_NAME.get('browser_navigate');
  const withNavigation = captureNeedsNavigation(intent, family)
    && !selected.some((tool) => tool.name === 'browser_navigate')
    && navigate !== undefined
    ? [navigate, ...selected].slice(0, 8)
    : selected;
  return orderedCaptureCapabilities(withNavigation, { intent, family });
}

export function selectLiveBrowserCapabilities(tools, { intent, family, mode = 'read' } = {}) {
  const selected = searchBrowserCapabilities({ intent, family, mode });
  const available = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool?.name, tool]));
  return selected
    .map(({ name }) => available.get(name))
    .filter(Boolean)
    .map((tool) => {
      const policy = CATALOG_BY_NAME.get(tool.name);
      return {
        name: tool.name,
        description: tool.description || policy.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        annotations: tool.annotations || {},
        family: policy.family,
        risk: policy.risk,
      };
    });
}

export function authorizeBrowserAction(action, mode = 'read') {
  const tool = CATALOG_BY_NAME.get(String(action || ''));
  if (!tool) throw Object.assign(new Error('browser_meta_unknown_action'), { code: -32602 });
  if (tool.risk === 'unsafe') throw Object.assign(new Error('browser_meta_unsafe_action_forbidden'), { code: -32003 });
  if (tool.risk === 'write' && mode !== 'interactive') {
    throw Object.assign(new Error('browser_meta_interactive_action_disabled'), { code: -32003 });
  }
  return tool;
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/**
 * Compact, general execution contract carried with each capability receipt.
 * This is not a website-specific route table: it tells the caller how to use
 * the schemas it just received without wasting a turn on an unambiguous public
 * website or hallucinating a browser primitive that was never granted.
 */
function executionContract(orderedActions) {
  return {
    allowed_actions: orderedActions,
    capture_defaults: orderedActions.includes('browser_take_screenshot')
      ? {
        type: 'png',
        scale: 'css',
        fullPage: false,
        note: 'Use this render-safe viewport capture unless the user explicitly needs a full-page or device-scale image.',
      }
      : undefined,
    rules: [
      'Execute only an action in allowed_actions, in listed order. Do not call scripts or invent browser_* actions.',
      'For an unambiguous named public website, navigate directly to its canonical absolute HTTPS origin; ask only when the site is ambiguous.',
      'browser_navigate requires an absolute URL. Resolve a relative URL discovered in a snapshot against the current page URL before navigating.',
      'A transport failure can replace the browser session. If browser_execute reports browser_session_reset, call browser_capabilities with the original intent and restart its ordered plan from browser_navigate; never treat an about:blank capture as task output.',
      'A snapshot filename is browser-session evidence, not a chat attachment or general filesystem path. Use snapshot content and exact element references returned by the browser; never pass its filename to another file tool.',
      'For an element action or element screenshot, use an exact target reference returned by the latest browser_snapshot. Never guess a selector. Omit target for a viewport screenshot.',
      'Prefer type=png, scale=css, fullPage=false for an ordinary screenshot. Use fullPage or scale=device only when the request needs it and the resulting dimensions fit the renderer.',
      'When a capture exceeds a renderer limit, retry once as a viewport PNG at CSS scale. Do not repeat discovery, save another snapshot, or guess an element target.',
      'Use browser_snapshot before drawing facts from a page. After a requested screenshot succeeds, stop unless further browser work is necessary to answer the request.',
    ],
  };
}

export function planMetaMcpRequest(request, { mode = 'read' } = {}) {
  if (request?.method === 'tools/list') {
    return { local: { jsonrpc: '2.0', id: request.id, result: { tools: META_TOOL_SCHEMAS } } };
  }
  if (request?.method !== 'tools/call') return { upstream: request };
  if (request?.params?.name === 'browser_capabilities') {
    const args = request.params.arguments || {};
    if (!String(args.intent || '').trim()) {
      return { local: { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'intent_required' } } };
    }
    return {
      capabilitySearch: {
        intent: args.intent,
        family: args.family,
        request: { jsonrpc: '2.0', id: request.id, method: 'tools/list', params: {} },
      },
    };
  }
  if (request?.params?.name === 'browser_execute') {
    const args = request.params.arguments || {};
    try {
      const capability = authorizeBrowserAction(args.action, mode);
      return {
        upstream: {
          ...request,
          params: { name: capability.name, arguments: args.arguments || {} },
        },
      };
    } catch (error) {
      return { local: { jsonrpc: '2.0', id: request.id, error: { code: error.code || -32602, message: error.message } } };
    }
  }
  return { local: { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'browser_meta_tool_not_found' } } };
}

export function renderCapabilitySearchResponse(requestId, upstreamResponse, search, { mode = 'read' } = {}) {
  if (upstreamResponse?.error) return { jsonrpc: '2.0', id: requestId, error: upstreamResponse.error };
  const capabilities = selectLiveBrowserCapabilities(upstreamResponse?.result?.tools, { ...search, mode });
  const orderedActions = capabilities.map((capability) => capability.name);
  const requiresNavigation = orderedActions[0] === 'browser_navigate' && orderedActions.length > 1;
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: toolResult({
      mode,
      capabilities,
      plan: requiresNavigation
        ? {
          ordered_actions: orderedActions,
          note: 'Follow this ordered plan before responding; it prevents blank captures and grounds page facts before an image is taken.',
        }
        : undefined,
      execution: executionContract(orderedActions),
    }),
  };
}
