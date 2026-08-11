import crypto from 'node:crypto';

function idFor(...parts) {
  return `input-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

function getPath(value, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((current, part) => current == null ? undefined : current[part], value);
}

export function createRuntimeInputAdapter() {
  return {
    id: 'runtime-input',
    name: 'Runtime input checkpoint',
    description: 'Persists a resumable request for one declared playbook input. It performs no provider action.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const config = input.config || {};
      const inputKey = String(config.input_key || '').trim();
      if (!inputKey) throw new Error('runtime_input_key_required');
      if (config.action === 'resolve') {
        const candidatePaths = Array.isArray(config.candidate_paths) ? config.candidate_paths : [];
        const candidate = candidatePaths.map((path) => getPath(input.inputs, path))
          .find((value) => value != null && String(value).trim());
        const available = candidate != null;
        const outputKey = available
          ? String(config.available_key || 'input_available')
          : String(config.missing_key || 'input_missing');
        return { artifacts: [{
          id: idFor(context.runId, context.stageId, inputKey, available ? String(candidate) : 'missing'),
          key: outputKey,
          status: available ? 'READY' : 'MISSING',
          data: { input_key: inputKey, value: available ? candidate : null, value_type: String(config.value_type || 'string') },
          source_refs: [`runtime-run:${context.runId}`],
          external_ref: null,
        }] };
      }
      const outputKey = String(config.output_key || 'input_request');
      return {
        artifacts: [{
          id: idFor(context.runId, context.stageId, inputKey),
          key: outputKey,
          status: 'READY',
          data: {
            input_key: inputKey,
            label: String(config.label || inputKey).slice(0, 160),
            description: String(config.description || '').slice(0, 1000),
            value_type: String(config.value_type || 'string').slice(0, 40),
          },
          source_refs: [`runtime-run:${context.runId}`],
          external_ref: null,
        }],
      };
    },
  };
}
