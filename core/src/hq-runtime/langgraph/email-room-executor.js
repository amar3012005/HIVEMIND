import {
  roomVerdict,
  workEnvelope,
  workOrderPrompt,
} from '../work-dispatcher.js';

function normalizedList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function emailDeliverable(contract, { prospectId, type }) {
  const deliverables = Array.isArray(contract?.deliverables) ? contract.deliverables : [];
  const direct = deliverables.find((row) => {
    const rowType = String(row?.type || row?.kind || '').trim().toLowerCase().replaceAll('-', '_');
    const rowProspect = String(row?.prospect_id || row?.prospectId || '').trim();
    return rowType === type && rowProspect === prospectId;
  });
  if (direct) return direct;

  // The Room engine owns the machine artifact boundary. Email drafting returns
  // one `email_drafts` artifact with verified records rather than model-authored
  // one-off deliverables. Normalize that authoritative shape for the lifecycle.
  for (const artifact of deliverables) {
    const kind = String(artifact?.kind || artifact?.type || '').trim().toLowerCase().replaceAll('-', '_');
    if (kind !== 'email_drafts' || !Array.isArray(artifact.records)) continue;
    const record = artifact.records.find((row) => {
      const rowProspect = String(row?.prospect_id || row?.prospectId || '').trim();
      const rowCompany = String(row?.prospect_company || row?.company || '').trim().toLowerCase();
      return rowProspect === prospectId || rowCompany === String(artifact.prospect_company || '').trim().toLowerCase();
    }) || (artifact.records.length === 1 ? artifact.records[0] : null);
    if (!record) continue;
    return {
      ...record,
      type,
      prospect_id: record.prospect_id || prospectId,
      evidence_refs: [
        ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : []),
        record.source_url,
      ].filter(Boolean),
    };
  }
  return null;
}

function draftFromDeliverable(deliverable, contract, prospect) {
  const payload = deliverable?.payload && typeof deliverable.payload === 'object'
    ? deliverable.payload
    : deliverable || {};
  const recipient = String(payload.recipient || payload.to || '').trim().toLowerCase();
  const verifiedRecipient = String(prospect.email || '').trim().toLowerCase();
  const subject = String(payload.subject || '').trim();
  const body = String(payload.body || payload.text || '').trim();
  const evidenceRefs = [...new Set([
    ...normalizedList(payload.evidence_refs || payload.evidenceRefs),
    ...normalizedList(deliverable?.evidence_refs || deliverable?.evidenceRefs),
    ...normalizedList(contract?.evidence_refs),
  ])];

  if (!verifiedRecipient || recipient !== verifiedRecipient) {
    throw new Error(`email_room_recipient_not_verified:${prospect.id}`);
  }
  if (!subject || !body) throw new Error(`email_room_draft_incomplete:${prospect.id}`);
  if (!evidenceRefs.length) throw new Error(`email_room_draft_ungrounded:${prospect.id}`);
  return { recipient, subject, body, evidenceRefs };
}

function roomOrder({
  organizationId,
  workOrderId,
  executionId,
  prospect,
  touch,
  previousDraft,
  repair,
}) {
  const isFollowUp = touch > 1;
  const type = isFollowUp ? 'email_follow_up' : 'email_draft';
  const criterion = `Return exactly one ${type} deliverable for prospect ${prospect.id}`;
  return {
    id: `${executionId}:${type}:${prospect.id}:touch-${touch}`,
    org_id: organizationId,
    title: isFollowUp
      ? `Draft follow-up ${touch} for ${prospect.name}`
      : `Draft personalized email for ${prospect.name}`,
    objective: isFollowUp
      ? `Write one concise follow-up email for ${prospect.name}. Continue the accepted outreach angle without repeating the first email. Do not send.`
      : `Write one concise, personalized cold-email draft for ${prospect.name}. Use only the verified recipient and supplied evidence. Do not send.`,
    kind: 'email_drafting',
    room_tag: 'outreach',
    selected_skills: ['cold-email-sequence', 'evidence-first'],
    acceptance_criteria: [
      criterion,
      `Recipient must equal the verified address ${prospect.email}`,
      'Subject, body, and at least one evidence reference must be present',
    ],
    required_evidence: normalizedList(prospect.evidenceRefs),
    evidence_refs: normalizedList(prospect.evidenceRefs),
    input_snapshot: {
      target: {
        prospect_id: prospect.id,
        company_name: prospect.name,
        contact_name: prospect.contactName,
        verified_recipient: prospect.email,
        fit_rationale: prospect.fitRationale || null,
        outreach_angle: prospect.outreachAngle,
      },
      authority: { mode: 'PREPARE', external_writes: false },
      completion_requirements: [
        { type: 'email_drafts', minimum: 1, maximum: 1 },
        { type: 'external_actions', minimum: 0, maximum: 0 },
      ],
      upstream_result: {
        deliverables: [{
          kind: 'prospect_records',
          source: 'shared_lead_book',
          record_count: 1,
          records: [{
            prospect_id: prospect.id,
            company: prospect.name,
            contact_name: prospect.contactName || null,
            email: prospect.email,
            fit_reason: prospect.fitRationale || null,
            outreach_angle: prospect.outreachAngle || null,
            source_url: normalizedList(prospect.evidenceRefs)[0] || null,
          }],
        }],
        previous_draft: previousDraft ? {
          id: previousDraft.id,
          subject: previousDraft.subject,
          body: previousDraft.body,
          repair: Boolean(repair),
        } : null,
      },
      lifecycle: {
        execution_id: executionId,
        parent_work_order_id: workOrderId,
        prospect_id: prospect.id,
        touch,
      },
    },
  };
}

export function createEmailRoomExecutor({ invokeRoom }) {
  if (typeof invokeRoom !== 'function') throw new Error('email_room_invoke_missing');

  const executeDraft = async (input, touch) => {
    const order = roomOrder({ ...input, touch });
    const response = await invokeRoom({
      roomTag: 'outreach',
      order,
      userMessage: workOrderPrompt(order),
      executionContext: workEnvelope(order),
    });
    const verdict = roomVerdict(response);
    if (verdict.status !== 'completed' || !verdict.contract) {
      const reason = verdict.gaps?.join('; ') || 'Room contract was not accepted';
      throw new Error(`email_room_work_incomplete:${input.prospect.id}:${reason}`);
    }
    const type = touch > 1 ? 'email_follow_up' : 'email_draft';
    const deliverable = emailDeliverable(verdict.contract, {
      prospectId: input.prospect.id,
      type,
    });
    if (!deliverable) throw new Error(`email_room_deliverable_missing:${input.prospect.id}:${type}`);
    return draftFromDeliverable(deliverable, verdict.contract, input.prospect);
  };

  return {
    async draftEmail(input) {
      return executeDraft(input, 1);
    },

    async draftFollowUp(input) {
      return executeDraft(input, Number(input.touch || 2));
    },

    async governDrafts({ prospectIds, drafts }) {
      const byProspect = new Map(drafts.map((draft) => [draft.prospectId, draft]));
      const issues = [];
      for (const prospectId of prospectIds) {
        const draft = byProspect.get(prospectId);
        if (!draft?.recipient || !draft?.subject || !draft?.body) {
          issues.push({ prospectId, code: 'email_draft_incomplete' });
        } else if (!normalizedList(draft.evidenceRefs).length) {
          issues.push({ prospectId, code: 'email_draft_ungrounded' });
        }
      }
      return {
        accepted: issues.length === 0,
        repairIds: [...new Set(issues.map((issue) => issue.prospectId))],
        issues,
      };
    },

    async governFollowUp({ prospectId, draft }) {
      const accepted = Boolean(
        draft?.recipient && draft?.subject && draft?.body
        && normalizedList(draft.evidenceRefs).length,
      );
      return {
        accepted,
        issues: accepted ? [] : [{ prospectId, code: 'email_follow_up_incomplete' }],
      };
    },
  };
}
