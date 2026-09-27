export interface CheckpointStore {
  readWorkCheckpoint(runId: string, stage: string): Promise<{ value: unknown } | null>;
  writeWorkCheckpoint(runId: string, stage: string, value: unknown): Promise<void>;
}

// Native Workflow steps survive suspension. This journal also survives an explicit restart.
export async function checkpoint<T>(store: CheckpointStore, runId: string, stage: string, execute: () => Promise<T>): Promise<T> {
  const saved = await store.readWorkCheckpoint(runId, stage);
  if (saved) return saved.value as T;
  const value = await execute();
  await store.writeWorkCheckpoint(runId, stage, value ?? null);
  return value;
}
