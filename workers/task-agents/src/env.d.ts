interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {}
interface DurableObjectStub {}

interface Workflow {
  create(options: { id?: string; params: unknown }): Promise<{ id: string }>;
}

interface Env {
  AI: unknown;
  HIVEMIND_CONTROL_URL?: string;
  TEST_TURN_TOKEN?: string;
  ROOM_STREAM_TOKEN?: string;
  HIVEMIND_MASTER_API_KEY?: string;
  HIVEMIND_META_URL?: string;
  BROWSER?: unknown;
  HivemindTaskAgent: DurableObjectNamespace;
  TASK_LIFECYCLE: Workflow;
}

interface ExportedHandler<E> {
  fetch(request: Request, env: E): Promise<Response> | Response;
}
