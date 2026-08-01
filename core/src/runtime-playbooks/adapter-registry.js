const OPERATIONS = Object.freeze(['execute', 'verify', 'monitor']);

function identifier(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,119}$/.test(normalized)) {
    throw new Error(`runtime_adapter_${label}_invalid`);
  }
  return normalized;
}

function publicDescriptor(adapter) {
  return {
    adapter_id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    operations: OPERATIONS.filter((operation) => typeof adapter[operation] === 'function'),
    input_schema: adapter.inputSchema || {},
  };
}

export class RuntimeAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(definition) {
    const id = identifier(definition?.id, 'id');
    if (this.adapters.has(id)) throw new Error(`runtime_adapter_duplicate:${id}`);
    const operations = OPERATIONS.filter((operation) => typeof definition?.[operation] === 'function');
    if (operations.length === 0) throw new Error(`runtime_adapter_operations_missing:${id}`);
    const adapter = {
      id,
      name: String(definition.name || id).slice(0, 180),
      description: String(definition.description || '').slice(0, 1000),
      inputSchema: definition.inputSchema && typeof definition.inputSchema === 'object' ? definition.inputSchema : {},
      execute: definition.execute,
      verify: definition.verify,
      monitor: definition.monitor,
    };
    this.adapters.set(id, adapter);
    return publicDescriptor(adapter);
  }

  descriptors() {
    return [...this.adapters.values()].map(publicDescriptor).sort((left, right) => left.adapter_id.localeCompare(right.adapter_id));
  }

  async invoke(adapterId, operation, input, executionContext) {
    const id = identifier(adapterId, 'id');
    if (!OPERATIONS.includes(operation)) throw new Error(`runtime_adapter_operation_invalid:${operation}`);
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`runtime_adapter_not_found:${id}`);
    if (typeof adapter[operation] !== 'function') throw new Error(`runtime_adapter_operation_unsupported:${id}:${operation}`);
    const context = executionContext && typeof executionContext === 'object' ? executionContext : {};
    if (!context.orgId || !context.runId || !context.stageId) {
      throw new Error('runtime_adapter_execution_context_required');
    }
    const result = await adapter[operation](input && typeof input === 'object' ? input : {}, Object.freeze({
      orgId: String(context.orgId),
      runId: String(context.runId),
      stageId: String(context.stageId),
      roomId: context.roomId ? String(context.roomId) : null,
      actorId: context.actorId ? String(context.actorId) : null,
    }));
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(`runtime_adapter_result_invalid:${id}:${operation}`);
    }
    return result;
  }
}

export const runtimeAdapterOperations = OPERATIONS;
