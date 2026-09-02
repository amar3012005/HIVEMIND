import { workflowInstanceId, type ProjectionParams } from './contract';

type ProjectionWorkflow = {
  create(input: any): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
};

export async function admitQueuedProjection(workflow: ProjectionWorkflow, params: ProjectionParams): Promise<void> {
  const id = workflowInstanceId(params);
  try {
    await workflow.create({
      id, params,
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    });
  } catch {
    // Queue delivery is at-least-once. A duplicate admission may observe an
    // active, completed, or failed Workflow, but it must never turn a terminal
    // failure into a second projection attempt.
    const existing = await workflow.get(id);
    await existing.status();
  }
}
