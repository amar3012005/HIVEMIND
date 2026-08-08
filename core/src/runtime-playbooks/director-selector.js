import { chatCompletionFetch, DEFAULT_CHAT_PLANNER_MODEL } from '../llm/chat-provider.js';

function parseJsonContent(payload) {
  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('runtime_playbook_selection_json_invalid');
    return JSON.parse(content.slice(start, end + 1));
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPath(value, path) {
  return String(path).split('.').reduce((current, part) => current == null ? undefined : current[part], value);
}

function setPath(target, path, value) {
  const parts = String(path).split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function valueMatches(field, value) {
  if (field.type === 'array') return Array.isArray(value);
  if (field.type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (field.type === 'integer') return Number.isInteger(value);
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === field.type;
}

function bindContext(playbook, selected, context) {
  const fields = playbook.input_contract?.fields || [];
  if (!fields.length) return null;
  const supplied = asObject(selected.bindings);
  const patch = {};
  for (const field of fields) {
    // Durable runtime context is canonical. The Director may fill absent fields,
    // but it cannot replace tenant evidence with an inferred value.
    let value = getPath(context, field.path);
    if (value === undefined || value === null) value = supplied[field.path];
    if (value === null) value = undefined;
    if (value === undefined && Object.prototype.hasOwnProperty.call(field, 'default_value')) value = field.default_value;
    if (value === undefined) {
      if (field.required) throw new Error(`runtime_playbook_binding_required:${field.path}`);
      continue;
    }
    if (!valueMatches(field, value)) throw new Error(`runtime_playbook_binding_type_invalid:${field.path}:${field.type}`);
    if (field.enum && !field.enum.includes(value)) throw new Error(`runtime_playbook_binding_value_invalid:${field.path}`);
    setPath(patch, field.path, value);
  }
  return patch;
}

export class DirectorPlaybookSelector {
  constructor({
    registry,
    completionFetch = chatCompletionFetch,
    model = process.env.RUNTIME_PLAYBOOK_SELECTOR_MODEL || DEFAULT_CHAT_PLANNER_MODEL,
    timeoutMs = 15_000,
  } = {}) {
    if (!registry) throw new Error('runtime_playbook_selector_registry_required');
    this.registry = registry;
    this.completionFetch = completionFetch;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async select({ objective, context = {}, scopeKey = 'global' } = {}) {
    // The upstream Director has already selected the accountable Room from the
    // complete company catalog. Keep lifecycle selection inside that ownership
    // boundary so a missing playbook cannot silently substitute another Room.
    const active = this.registry.descriptors({ scopeKey }).filter((entry) => entry.status === 'ACTIVE');
    // New assignments always use the newest active version. Existing runs remain
    // pinned to their immutable version through RuntimePlaybookRun.
    let catalog = [...active.reduce((latest, entry) => {
      if (!latest.has(entry.playbook_id)) latest.set(entry.playbook_id, entry);
      return latest;
    }, new Map()).values()];
    const requested = asObject(asObject(context).request);
    const requestedOwner = String(requested.owner_room_tag || '').trim().toLowerCase();
    if (requestedOwner) {
      catalog = catalog.filter((entry) => String(entry.metadata?.owner_room_tag || '').trim().toLowerCase() === requestedOwner);
      if (catalog.length === 0) {
        return {
          playbook_id: null,
          version: null,
          reason: `no_active_playbook_for_selected_room:${requestedOwner}`,
        };
      }
    }
    if (requested.playbook_id) {
      catalog = catalog.filter((entry) => entry.playbook_id === requested.playbook_id
        && (requested.playbook_version == null || entry.version === Number(requested.playbook_version)));
    }
    if (catalog.length === 0) throw new Error('runtime_playbook_catalog_empty');
    let previousError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.completionFetch(this.model, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          temperature: 0,
          response_format: { type: 'json_object' },
          max_completion_tokens: 1000,
          messages: [
            {
              role: 'system',
              content: 'Select one executable playbook from the supplied registry only when its complete lifecycle and metadata directly implement the exact requested action and terminal outcome. The objective may be written in any language. Prioritize request.requested_action and request.acceptance_criteria over a merely related business outcome. A lifecycle that can facilitate an upstream or downstream result is not compatible unless its supported_actions directly include the requested provider effect. The upstream Director has already selected the accountable Room, so every supplied playbook is inside that ownership boundary. Never infer an identifier that is absent from the registry. Return matched_supported_action as one exact value from the selected playbook metadata.supported_actions. Return acceptable_terminal_states as a non-empty subset of the selected playbook terminal_states that genuinely satisfy the original request; a prepared state cannot satisfy a requested external delivery. Bind only declared input_contract fields from the objective and supplied context, keyed by exact field path. If none fits, return {"playbook_id":null,"version":null,"reason":"brief reason"}. Otherwise return {"playbook_id":"exact registry id","version":integer,"matched_supported_action":"exact supported action","reason":"brief evidence-based reason","acceptable_terminal_states":["exact terminal"],"bindings":{"declared.path":value}}. Return one complete JSON object only.',
            },
            { role: 'user', content: JSON.stringify({
              objective: String(objective || '').slice(0, 8000), context, playbooks: catalog,
              ...(previousError ? { correction: `The previous response was invalid (${previousError}). Return a complete object matching the contract.` } : {}),
            }) },
          ],
        }),
      });
      if (!response.ok) {
        previousError = `runtime_playbook_selection_http_${response.status}`;
        if (attempt === 2) throw new Error(previousError);
        continue;
      }
      try {
        const selected = parseJsonContent(await response.json());
        if (selected.playbook_id == null) {
          return { playbook_id: null, version: null, reason: String(selected.reason || 'no_compatible_playbook').slice(0, 1000) };
        }
        const playbookId = String(selected.playbook_id || '').trim();
        const version = Number(selected.version);
        if (!playbookId || !Number.isInteger(version)) throw new Error('runtime_playbook_selection_shape_invalid');
        const allowed = catalog.some((entry) => entry.playbook_id === playbookId && entry.version === version);
        if (!allowed) throw new Error(`runtime_playbook_selection_not_in_registry:${playbookId}:${version}`);
        const playbook = this.registry.get(playbookId, version, { scopeKey });
        const runtimeRequest = Boolean(asObject(context).request);
        const supportedActions = Array.isArray(playbook.metadata?.supported_actions)
          ? playbook.metadata.supported_actions.map(String) : [];
        const matchedSupportedAction = String(selected.matched_supported_action || '').trim();
        if (runtimeRequest && supportedActions.length && !supportedActions.includes(matchedSupportedAction)) {
          throw new Error('runtime_playbook_supported_action_required');
        }
        let acceptableTerminalStates = Array.isArray(selected.acceptable_terminal_states)
          ? [...new Set(selected.acceptable_terminal_states.map(String).filter((state) => playbook.terminal_states.includes(state)))] : [];
        // Runtime assignments always include the durable request contract and
        // therefore require an explicit outcome binding. The broader selector
        // API remains backwards-compatible for non-Runtime registry consumers.
        if (!acceptableTerminalStates.length && runtimeRequest) {
          throw new Error('runtime_playbook_acceptable_terminal_states_required');
        }
        if (!acceptableTerminalStates.length) acceptableTerminalStates = [...playbook.terminal_states];
        const contextPatch = bindContext(playbook, selected, context);
        return {
          playbook_id: playbookId,
          version,
          reason: String(selected.reason || '').slice(0, 1000),
          ...(matchedSupportedAction ? { matched_supported_action: matchedSupportedAction } : {}),
          ...(runtimeRequest || Array.isArray(selected.acceptable_terminal_states)
            ? { acceptable_terminal_states: acceptableTerminalStates } : {}),
          ...(contextPatch ? { context_patch: contextPatch } : {}),
        };
      } catch (error) {
        previousError = String(error?.message || error).slice(0, 500);
        if (attempt === 2) throw error;
      }
    }
    throw new Error(previousError || 'runtime_playbook_selection_failed');
  }
}
