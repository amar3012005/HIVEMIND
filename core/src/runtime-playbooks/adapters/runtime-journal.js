import crypto from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function idFor(...parts) {
  return `journal-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

export function createRuntimeJournalAdapter({ prisma } = {}) {
  if (!prisma) throw new Error('runtime_journal_adapter_prisma_required');
  return {
    id: 'runtime-journal',
    name: 'Runtime journal',
    description: 'Appends one tenant-scoped, idempotent operating decision from persisted stage evidence.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const config = input.config || {};
      const sourceKey = String(config.input_key || '').trim();
      const records = asArray(input.inputs?.[`artifacts.${sourceKey}`]);
      const outputKey = String(config.output_key || 'journal_record');
      const room = context.roomId ? await prisma.hyperRoom.findFirst({
        where: { id: context.roomId, orgId: context.orgId }, select: { userId: true },
      }) : null;
      const artifacts = [];
      for (const record of records) {
        const identity = idFor(context.runId, context.stageId, record.id);
        let journal = await prisma.growthJournal.findFirst({
          where: { orgId: context.orgId, decision: { path: ['runtime_journal_key'], equals: identity } },
        });
        if (!journal) {
          journal = await prisma.growthJournal.create({ data: {
            orgId: context.orgId,
            actorUserId: room?.userId || null,
            eventType: String(config.event_type || 'runtime_decision').slice(0, 60),
            summary: String(record.data?.summary || record.data?.outcome || 'Runtime decision recorded.').slice(0, 8000),
            evidenceRefs: [record.id, ...(record.source_refs || [])],
            decision: {
              runtime_journal_key: identity,
              runtime_playbook_run_id: context.runId,
              runtime_stage_id: context.stageId,
              source_artifact_id: record.id,
              outcome: record.data?.outcome || null,
              next_action: record.data?.next_action || null,
              action_items: record.data?.action_items || [],
            },
          } });
        }
        artifacts.push({
          id: identity,
          key: outputKey,
          status: 'READY',
          data: { input_ref: record.id, journal_ref: journal.id },
          source_refs: [record.id, `growth-journal:${journal.id}`],
          external_ref: journal.id,
        });
      }
      return { artifacts };
    },
  };
}
