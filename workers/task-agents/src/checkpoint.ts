export interface CheckpointStore {
  readWorkCheckpoint(runId: string, stage: string): Promise<{ value: unknown } | null>;
  writeWorkCheckpoint(runId: string, stage: string, value: unknown): Promise<void>;
}
import { workflowErrorCode } from "./workflow-error.ts";

// Native Workflow steps survive suspension. This journal also survives an explicit restart.
export async function checkpoint<T>(store: CheckpointStore, runId: string, stage: string, execute: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const saved = await store.readWorkCheckpoint(runId, stage);
  if (saved) {
    console.log(JSON.stringify({ event: "workrun_stage", runId, stage, outcome: "replayed", elapsedMs: Date.now() - started }));
    return saved.value as T;
  }
  try {
    const value = await execute();
    await store.writeWorkCheckpoint(runId, stage, value ?? null);
    console.log(JSON.stringify({ event: "workrun_stage", runId, stage, outcome: "completed", elapsedMs: Date.now() - started }));
    return value;
  } catch (error) {
    console.error(JSON.stringify({ event: "workrun_stage", runId, stage, outcome: "failed", code: workflowErrorCode(error), elapsedMs: Date.now() - started }));
    throw error;
  }
}
