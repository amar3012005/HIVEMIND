import crypto from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactId(...parts) {
  return `lead-timeline-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

export function createLeadTimelineAdapter({ prisma } = {}) {
  if (!prisma) throw new Error('lead_timeline_adapter_prisma_required');
  return {
    id: 'lead-timeline',
    name: 'Lead timeline',
    description: 'Persists lead-specific lifecycle learning without changing company-wide strategy.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      const config = input.config || {};
      const analyses = asArray(input.inputs?.[`artifacts.${config.input_key || 'call_analysis'}`]);
      const contracts = asArray(input.inputs?.[`artifacts.${config.contract_key || 'call_contract'}`]);
      const outputKey = String(config.output_key || 'lead_timeline_record');
      const room = context.roomId ? await prisma.hyperRoom.findFirst({
        where: { id: context.roomId, orgId: context.orgId }, select: { userId: true },
      }) : null;
      const artifacts = [];

      for (const [index, analysis] of analyses.entries()) {
        const contract = contracts[index] || contracts[0] || null;
        const targetRef = String(contract?.data?.target_ref || '').trim();
        const leadRef = String(contract?.data?.lead_ref || '').trim();
        const identity = artifactId(context.runId, context.stageId, analysis.id, targetRef || leadRef || index);
        const timeline = {
          runtime_playbook_run_id: context.runId,
          runtime_stage_id: context.stageId,
          source_artifact_id: analysis.id,
          target_ref: targetRef || null,
          lead_ref: leadRef || null,
          terminal_state: analysis.data?.terminal_state || null,
          outcome: analysis.data?.outcome || null,
          sentiment: analysis.data?.sentiment || null,
          objections: analysis.data?.objections || [],
          lead_notes: analysis.data?.lead_notes || null,
          tara_learnings: analysis.data?.tara_learnings || [],
          next_action: analysis.data?.next_action || null,
        };
        let journal = await prisma.growthJournal.findFirst({
          where: { orgId: context.orgId, decision: { path: ['lead_timeline_key'], equals: identity } },
        });
        if (!journal) {
          journal = await prisma.growthJournal.create({ data: {
            orgId: context.orgId,
            actorUserId: room?.userId || null,
            eventType: 'lead_call_outcome',
            summary: String(analysis.data?.summary || analysis.data?.outcome || 'TARA call outcome retained.').slice(0, 8000),
            evidenceRefs: [analysis.id, ...(analysis.source_refs || [])],
            decision: { lead_timeline_key: identity, ...timeline },
          } });
        }
        if (targetRef) {
          const target = await prisma.outreachTarget.findFirst({ where: { id: targetRef, campaign: { orgId: context.orgId } } });
          if (target) {
            await prisma.outreachTarget.update({ where: { id: target.id }, data: {
              state: analysis.data?.terminal_state === 'call_failed' ? 'failed' : 'analyzed',
              resultRef: { ...(target.resultRef || {}), callAnalysis: timeline, growthJournalId: journal.id },
            } });
          }
        }
        artifacts.push({
          id: identity,
          key: outputKey,
          status: 'READY',
          data: { input_ref: analysis.id, lead_ref: leadRef || null, target_ref: targetRef || null, journal_ref: journal.id },
          source_refs: [analysis.id, `growth-journal:${journal.id}`],
          external_ref: journal.id,
        });
      }
      return { artifacts };
    },
  };
}
