import crypto from 'node:crypto';
import { runGoogleTool } from '../../connectors/google-native.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}

function draftRef(artifact) {
  return String(artifact?.data?.draft_ref || artifact?.external_ref || '').trim();
}

function inputArtifacts(input, ref) {
  return asArray(input?.inputs?.[ref]);
}

function providerStatus(error) {
  const direct = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if (direct) return direct;
  const match = String(error?.message || error || '').match(/(?:Google API|HTTP|status)\s+(\d{3})/i);
  return Number(match?.[1] || 0);
}

function normalizedMessageId(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function operationMessageId(context, artifact, operation) {
  return `runtime-${crypto.createHash('sha256')
    .update([context.runId, context.stageId, operation, artifact.id].map(String).join('\u0000'))
    .digest('hex')}@singulance.local`;
}

function validRecipient(value) {
  const recipient = String(value || '').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient);
}

function actionOutcome(context, artifact, { key, operation, reason, status = null }) {
  return {
    id: artifactId('action', context.runId, context.stageId, operation, artifact?.id || 'unknown', key),
    key,
    status: key.includes('rejection') ? 'REJECTED' : 'UNCERTAIN',
    data: {
      input_ref: artifact?.id || null,
      message_ref: artifact?.key === 'message_record' ? artifact.id : artifact?.data?.message_ref || null,
      draft_ref: draftRef(artifact) || null,
      lead_ref: artifact?.data?.lead_ref || null,
      recipient_ref: artifact?.data?.recipient || artifact?.data?.recipient_ref || null,
      operation,
      reason: String(reason || key).slice(0, 1000),
      provider_status: status || null,
    },
    source_refs: artifact?.source_refs || [],
    external_ref: null,
  };
}

function classifyWriteFailure(error) {
  const status = providerStatus(error);
  if ([400, 404, 410, 422].includes(status)) return { kind: 'rejection', status };
  if ([401, 403].includes(status)) return { kind: 'fatal', status };
  return { kind: 'uncertain', status: status || null };
}

function messageDraftArtifact(context, artifact, draft, messageId = null, key = 'draft_record') {
  const draftId = String(draft?.draftId || '').trim();
  return {
    id: artifactId('draft', context.runId, artifact.id, draftId),
    key,
    status: 'READY',
    data: {
      input_ref: artifact.id,
      draft_ref: draftId,
      message_ref: artifact.id,
      lead_ref: artifact?.data?.lead_ref || null,
      recipient_ref: String(artifact?.data?.recipient || '').trim(),
      subject: String(artifact?.data?.subject || '').trim(),
      body: String(artifact?.data?.body || '').trim(),
      delivery_requested: artifact?.data?.delivery_requested === true,
      thread_id: draft?.threadId || null,
      idempotency_message_id: normalizedMessageId(messageId || draft?.headerMessageId),
    },
    source_refs: [...new Set([...(artifact?.source_refs || []), `gmail-draft:${draftId}`])],
    external_ref: draftId,
  };
}

async function ownerFor(prisma, context) {
  const room = await prisma.hyperRoom.findFirst({
    where: { id: context.roomId, orgId: context.orgId, archivedAt: null },
    select: { userId: true },
  });
  if (!room?.userId) throw new Error('runtime_gmail_room_owner_not_found');
  return { user_id: room.userId, org_id: context.orgId };
}

async function getDraft(runTool, actor, ref) {
  return runTool('gmail_get_draft', { draftId: ref }, actor);
}

async function findDraftByMessageId(runTool, actor, messageId) {
  const result = await runTool('gmail_list_drafts', { max: 30 }, actor).catch(() => null);
  const wanted = normalizedMessageId(messageId);
  const matches = asArray(result?.drafts).filter((draft) => normalizedMessageId(draft?.headerMessageId) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

async function findSentByMessageId(runTool, actor, messageId) {
  if (!messageId) return null;
  const result = await runTool('gmail_search', {
    query: `in:sent rfc822msgid:${normalizedMessageId(messageId)}`,
    max: 5,
  }, actor).catch(() => null);
  const matches = asArray(result?.messages);
  return matches.length === 1 ? matches[0] : null;
}

async function existingOutbound(prisma, context, ref) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, recipient, subject, message_id, thread_id, meta
       FROM "hivemind"."outbound_actions"
      WHERE org_id = $1::uuid
        AND channel = 'email'
        AND status = 'sent'
        AND meta->>'runtime_playbook_run_id' = $2
        AND meta->>'draft_ref' = $3
      ORDER BY sent_at DESC LIMIT 1`,
    context.orgId, context.runId, ref,
  );
  return rows[0] || null;
}

async function persistOutbound(prisma, context, draft, receipt, artifact) {
  const meta = {
    origin: 'hq_runtime',
    via: 'runtime-playbook',
    runtime_playbook_run_id: context.runId,
    runtime_playbook_stage_id: context.stageId,
    draft_ref: draft.draftId,
    idempotency_message_id: artifact?.data?.idempotency_message_id || null,
    lead_ref: artifact?.data?.lead_ref || null,
    correlation_ref: receipt.threadId,
  };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."outbound_actions"
       (org_id, user_id, room_id, channel, recipient, subject, message_id, thread_id, status, meta)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'email', $4, $5, $6, $7, 'sent', $8::jsonb)
     ON CONFLICT DO NOTHING`,
    context.orgId, draft.userId, context.roomId,
    draft.to || null, draft.subject || null,
    receipt.id || null, receipt.threadId || null, JSON.stringify(meta),
  );
}

function receiptArtifact(context, artifact, draft, receipt, key = 'delivery_receipt') {
  const providerId = String(receipt.message_id || receipt.id || '').trim();
  const threadId = String(receipt.thread_id || receipt.threadId || '').trim();
  return {
    id: artifactId('delivery', context.runId, draft.draftId, providerId),
    key,
    status: 'READY',
    data: {
      input_ref: artifact.id,
      provider_receipt_id: providerId,
      thread_id: threadId,
      correlation_ref: threadId,
      draft_ref: draft.draftId,
      lead_ref: artifact?.data?.lead_ref || null,
      message_ref: artifact?.data?.message_ref || null,
      status: 'accepted',
      external_action_marker: {
        id: `gmail:${providerId}`,
        presentation_type: 'message',
        provider: 'gmail',
        channel: 'gmail',
        status: 'sent',
        headline: 'Congratulations! Your email was sent.',
        note: `Gmail accepted the message${draft?.to ? ` to ${draft.to}` : ''}.`,
        payload: {
          to: draft?.to || artifact?.data?.recipient_ref || null,
          subject: draft?.subject || artifact?.data?.subject || null,
          body: draft?.body || draft?.text || draft?.message || artifact?.data?.body || null,
          provider_receipt_id: providerId,
          thread_id: threadId,
        },
      },
    },
    source_refs: [`gmail:${providerId}`],
    external_ref: providerId,
  };
}

export function createGmailRuntimeAdapter({ prisma, runTool = null } = {}) {
  if (!prisma) throw new Error('runtime_gmail_prisma_required');
  const google = runTool || ((tool, args, actor) => runGoogleTool(tool, args, actor, prisma));
  return {
    id: 'gmail',
    name: 'Gmail',
    description: 'Verifies drafts, sends authority-approved drafts, and creates reply correlation subscriptions.',
    async execute(input, context) {
      if (input?.config?.action !== 'prepare_drafts') {
        return deliverDrafts(input, context);
      }
      const inputKey = String(input?.config?.input_key || 'message_record');
      const outputKey = String(input?.config?.output_key || 'draft_record');
      const rejectionKey = String(input?.config?.rejection_key || 'action_rejection');
      const uncertainKey = String(input?.config?.uncertain_key || 'action_uncertain');
      const messages = inputArtifacts(input, `artifacts.${inputKey}`);
      const actor = await ownerFor(prisma, context);
      const produced = [];
      const warnings = [];
      for (const artifact of messages) {
        const recipient = String(artifact?.data?.recipient || '').trim();
        const subject = String(artifact?.data?.subject || '').trim();
        const body = String(artifact?.data?.body || '').trim();
        if (!validRecipient(recipient) || !subject || !body) {
          const reason = !validRecipient(recipient) ? 'invalid_recipient' : !subject ? 'missing_subject' : 'missing_body';
          produced.push(actionOutcome(context, artifact, { key: rejectionKey, operation: 'prepare_draft', reason }));
          warnings.push({ input_ref: artifact?.id || null, reason });
          continue;
        }
        const messageId = operationMessageId(context, artifact, 'prepare_draft');
        let draft;
        try {
          draft = await google('gmail_create_draft', {
            to: recipient,
            subject,
            body,
            markdown: true,
            messageId,
          }, actor);
        } catch (cause) {
          const classification = classifyWriteFailure(cause);
          if (classification.kind === 'fatal') throw cause;
          if (classification.kind === 'uncertain') {
            draft = await findDraftByMessageId(google, actor, messageId);
          }
          if (!draft?.draftId) {
            const key = classification.kind === 'rejection' ? rejectionKey : uncertainKey;
            produced.push(actionOutcome(context, artifact, {
              key,
              operation: 'prepare_draft',
              reason: cause?.message || cause,
              status: classification.status,
            }));
            warnings.push({ input_ref: artifact?.id || null, reason: String(cause?.message || cause), uncertain: key === 'action_uncertain' });
            continue;
          }
        }
        if (!draft?.draftId) {
          produced.push(actionOutcome(context, artifact, {
            key: uncertainKey, operation: 'prepare_draft', reason: 'provider_draft_receipt_incomplete',
          }));
          warnings.push({ input_ref: artifact?.id || null, reason: 'provider_draft_receipt_incomplete', uncertain: true });
          continue;
        }
        produced.push(messageDraftArtifact(context, artifact, draft, messageId, outputKey));
      }
      return { artifacts: produced, gaps: [], warnings };
    },
    async verify(input, context) {
      const artifacts = asArray(input.artifacts);
      const actor = await ownerFor(prisma, context);
      const checks = await Promise.all(artifacts.map(async (artifact) => {
        const reference = draftRef(artifact);
        if (!reference) return { reference, draft: null };
        const draft = await getDraft(google, actor, reference).catch(() => null);
        return { reference, draft };
      }));
      const missing = checks.filter((row) => !row.draft || String(row.draft.draftId || '') !== row.reference)
        .map((row) => row.reference);
      return {
        passed: missing.length === 0,
        evidence: checks.filter((row) => row.draft)
          .map((row) => ({ type: 'provider_draft', id: row.draft.draftId })),
        unmet: missing.map((reference) => ({ predicate: 'provider_draft_exists', reason: `draft_not_found:${reference || 'missing'}` })),
      };
    },
    async monitor(input, context) {
      const inputKey = String(input?.config?.input_key || 'delivery_receipt');
      const outputKey = String(input?.config?.output_key || 'observation_subscription');
      const rejectionKey = String(input?.config?.rejection_key || 'action_rejection');
      const receipts = inputArtifacts(input, `artifacts.${inputKey}`);
      const artifacts = [];
      const warnings = [];
      for (const receipt of receipts) {
        const correlation = String(receipt?.data?.correlation_ref || receipt?.data?.thread_id || '').trim();
        if (!correlation) {
          artifacts.push(actionOutcome(context, receipt, {
            key: rejectionKey, operation: 'monitor', reason: 'correlation_missing',
          }));
          warnings.push({ input_ref: receipt?.id || null, reason: 'correlation_missing' });
          continue;
        }
        artifacts.push({
          id: artifactId('subscription', context.runId, correlation),
          key: outputKey,
          status: 'READY',
          data: {
            input_ref: receipt.id,
            subscription_ref: `gmail-thread:${correlation}`,
            correlation_ref: correlation,
            delivery_ref: receipt.id,
            lead_ref: receipt?.data?.lead_ref || null,
          },
          source_refs: receipt.source_refs || [],
          external_ref: correlation,
        });
      }
      return { artifacts, gaps: [], warnings };
    },
  };

  async function deliverDrafts(input, context) {
    const inputKey = String(input?.config?.input_key || 'draft_record');
    const outputKey = String(input?.config?.output_key || 'delivery_receipt');
    const rejectionKey = String(input?.config?.rejection_key || 'action_rejection');
    const uncertainKey = String(input?.config?.uncertain_key || 'action_uncertain');
    const artifacts = inputArtifacts(input, `artifacts.${inputKey}`);
    const actor = await ownerFor(prisma, context);
    const produced = [];
    const warnings = [];
    for (const artifact of artifacts) {
      const ref = draftRef(artifact);
      if (!ref) {
        produced.push(actionOutcome(context, artifact, { key: rejectionKey, operation: 'deliver', reason: 'draft_reference_missing' }));
        warnings.push({ input_ref: artifact?.id || null, reason: 'draft_reference_missing' });
        continue;
      }
      const previous = await existingOutbound(prisma, context, ref);
      if (previous?.message_id && previous?.thread_id) {
          produced.push(receiptArtifact(context, artifact, { draftId: ref, to: previous.recipient, subject: previous.subject }, {
            message_id: previous.message_id,
            thread_id: previous.thread_id,
          }, outputKey));
        continue;
      }
      const idempotencyMessageId = artifact?.data?.idempotency_message_id || null;
      let providerDraft = await getDraft(google, actor, ref).catch(() => null);
      if (!providerDraft) {
        const sent = await findSentByMessageId(google, actor, idempotencyMessageId);
        if (sent?.id && sent?.threadId) {
          const recovered = { id: sent.id, threadId: sent.threadId };
          await persistOutbound(prisma, context, {
            draftId: ref,
            userId: actor.user_id,
            to: artifact?.data?.recipient_ref || sent.to,
            subject: sent.subject,
          }, recovered, artifact);
          produced.push(receiptArtifact(context, artifact, { draftId: ref }, recovered, outputKey));
          continue;
        }
        produced.push(actionOutcome(context, artifact, { key: rejectionKey, operation: 'deliver', reason: 'provider_draft_not_found', status: 404 }));
        warnings.push({ input_ref: artifact?.id || null, reason: 'provider_draft_not_found' });
        continue;
      }
      let receipt;
      try {
        receipt = await google('gmail_send_draft', { draftId: ref }, actor);
      } catch (cause) {
        const classification = classifyWriteFailure(cause);
        if (classification.kind === 'fatal') throw cause;
        if (classification.kind === 'uncertain') {
          const sent = await findSentByMessageId(google, actor, idempotencyMessageId);
          if (sent?.id && sent?.threadId) receipt = { id: sent.id, threadId: sent.threadId };
        }
        if (!receipt?.id || !receipt?.threadId) {
          const key = classification.kind === 'rejection' ? rejectionKey : uncertainKey;
          produced.push(actionOutcome(context, artifact, {
            key, operation: 'deliver', reason: cause?.message || cause, status: classification.status,
          }));
          warnings.push({ input_ref: artifact?.id || null, reason: String(cause?.message || cause), uncertain: key === 'action_uncertain' });
          continue;
        }
      }
      if (!receipt?.id || !receipt?.threadId) {
        produced.push(actionOutcome(context, artifact, {
          key: uncertainKey, operation: 'deliver', reason: 'provider_send_receipt_incomplete',
        }));
        warnings.push({ input_ref: artifact?.id || null, reason: 'provider_send_receipt_incomplete', uncertain: true });
        continue;
      }
      try {
        await persistOutbound(prisma, context, { ...providerDraft, draftId: ref, userId: actor.user_id }, receipt, artifact);
      } catch (cause) {
        const reconciled = await existingOutbound(prisma, context, ref).catch(() => null);
        if (!reconciled?.message_id || !reconciled?.thread_id) {
          produced.push(actionOutcome(context, artifact, {
            key: uncertainKey, operation: 'deliver', reason: `ledger_unconfirmed:${cause?.message || cause}`,
          }));
          warnings.push({ input_ref: artifact?.id || null, reason: 'ledger_unconfirmed', uncertain: true });
          continue;
        }
        receipt = { id: reconciled.message_id, threadId: reconciled.thread_id };
      }
      produced.push(receiptArtifact(context, artifact, { ...providerDraft, draftId: ref }, receipt, outputKey));
    }
    return { artifacts: produced, gaps: [], warnings };
  }
}
