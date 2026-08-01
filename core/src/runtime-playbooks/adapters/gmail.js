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
    lead_ref: artifact?.data?.lead_ref || null,
    correlation_ref: receipt.threadId,
  };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."outbound_actions"
       (org_id, user_id, room_id, channel, recipient, subject, message_id, thread_id, status, meta)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'email', $4, $5, $6, $7, 'sent', $8::jsonb)`,
    context.orgId, draft.userId, context.roomId,
    draft.to || null, draft.subject || null,
    receipt.id || null, receipt.threadId || null, JSON.stringify(meta),
  );
}

function receiptArtifact(context, artifact, draft, receipt) {
  const providerId = String(receipt.message_id || receipt.id || '').trim();
  const threadId = String(receipt.thread_id || receipt.threadId || '').trim();
  return {
    id: artifactId('delivery', context.runId, draft.draftId, providerId),
    key: 'delivery_receipt',
    status: 'READY',
    data: {
      provider_receipt_id: providerId,
      thread_id: threadId,
      correlation_ref: threadId,
      draft_ref: draft.draftId,
      lead_ref: artifact?.data?.lead_ref || null,
      status: 'accepted',
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
    async execute(input, context) {
      const artifacts = inputArtifacts(input, 'artifacts.draft_record');
      const actor = await ownerFor(prisma, context);
      const produced = [];
      for (const artifact of artifacts) {
        const ref = draftRef(artifact);
        const previous = await existingOutbound(prisma, context, ref);
        if (previous?.message_id && previous?.thread_id) {
          produced.push(receiptArtifact(context, artifact, { draftId: ref, to: previous.recipient, subject: previous.subject }, {
            message_id: previous.message_id,
            thread_id: previous.thread_id,
          }));
          continue;
        }
        const providerDraft = await getDraft(google, actor, ref).catch(() => null);
        if (!providerDraft) throw new Error(`runtime_gmail_draft_not_found:${ref || 'missing'}`);
        let receipt;
        try {
          receipt = await google('gmail_send_draft', { draftId: ref }, actor);
        } catch (cause) {
          const error = new Error(`runtime_gmail_send_ambiguous:${ref}:${cause?.message || cause}`);
          error.ambiguous = true;
          throw error;
        }
        if (!receipt?.id || !receipt?.threadId) {
          const error = new Error(`runtime_gmail_receipt_incomplete:${ref}`);
          error.ambiguous = true;
          throw error;
        }
        try {
          await persistOutbound(prisma, context, { ...providerDraft, draftId: ref, userId: actor.user_id }, receipt, artifact);
        } catch (cause) {
          const error = new Error(`runtime_gmail_ledger_ambiguous:${ref}:${cause?.message || cause}`);
          error.ambiguous = true;
          throw error;
        }
        produced.push(receiptArtifact(context, artifact, { ...providerDraft, draftId: ref }, receipt));
      }
      return { artifacts: produced, gaps: [] };
    },
    async monitor(input, context) {
      const receipts = inputArtifacts(input, 'artifacts.delivery_receipt');
      const artifacts = receipts.map((receipt) => {
        const correlation = String(receipt?.data?.correlation_ref || receipt?.data?.thread_id || '').trim();
        if (!correlation) throw new Error(`runtime_gmail_correlation_missing:${receipt?.id || 'unknown'}`);
        return {
          id: artifactId('subscription', context.runId, correlation),
          key: 'observation_subscription',
          status: 'READY',
          data: {
            subscription_ref: `gmail-thread:${correlation}`,
            correlation_ref: correlation,
            delivery_ref: receipt.id,
          },
          source_refs: receipt.source_refs || [],
          external_ref: correlation,
        };
      });
      return { artifacts, gaps: [] };
    },
  };
}
