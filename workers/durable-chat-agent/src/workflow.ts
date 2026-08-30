import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { isTerminalMetadata, validateMetadata, validateWorkflowParams, type ChatTurnWorkflowParams, type SessionMetadata } from './contract';

export class ChatTurnWorkflow extends WorkflowEntrypoint<Env, ChatTurnWorkflowParams> {
  async run(event: WorkflowEvent<ChatTurnWorkflowParams>, step: WorkflowStep) {
    const opened = await step.do('validate opaque chat turn', async () => {
      const payload = validateWorkflowParams(event.payload);
      return { turn_id: payload.turn_id, mode: payload.mode };
    });

    // Core performs semantic work and owns every customer datum. The Workflow
    // durably supervises only the opaque lifecycle and can wait across Worker,
    // browser, or Durable Object restarts without polling or prompt storage.
    const terminal = await step.waitForEvent<SessionMetadata>('wait for terminal chat state', {
      type: 'chat-terminal',
      timeout: '7 days',
    });
    const metadata = await step.do('validate terminal receipt', async () => {
      const value = validateMetadata(terminal.payload);
      if (!isTerminalMetadata(value)) throw new Error('non_terminal_receipt');
      if (value.turn_id !== opened.turn_id) throw new Error('turn_mismatch');
      return value;
    });
    return {
      ok: metadata.status === 'completed',
      turn_id: metadata.turn_id,
      status: metadata.status,
      phase: metadata.phase,
      sequence: metadata.sequence || 0,
      occurred_at: metadata.occurred_at,
    };
  }
}
