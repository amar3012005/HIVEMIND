import crypto from 'node:crypto';

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedKind(value) {
  return String(value || '').trim().toLowerCase().replaceAll('-', '_');
}

function stableProspectId(record = {}) {
  const direct = String(record.memory_id || record.prospect_id || record.id || record.place_id || '').trim();
  if (direct) return direct;
  const identity = `${normalizedEmail(record.email || record.to)}|${String(record.company || record.name || '').trim().toLowerCase()}`;
  return `prospect-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function artifactPayload(row) {
  return row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload : {};
}

function prospectFromRecord(record, artifact, memory = null) {
  const provenance = memory?.provenance && typeof memory.provenance === 'object' ? memory.provenance : {};
  const email = normalizedEmail(record.email || record.to || provenance.email);
  const name = String(record.company || record.name || provenance.company || memory?.title || '').replace(/^Prospect:\s*/i, '').trim();
  const evidenceRefs = [...new Set([
    ...asList(record.evidence_refs || record.evidenceRefs),
    ...asList(artifact?.sourceRefs),
    record.source_url,
    record.website,
    record.place_id ? `google-places:${record.place_id}` : null,
    memory?.id ? `memory:${memory.id}` : null,
  ].filter(Boolean).map(String))];
  return {
    id: String(memory?.id || stableProspectId(record)),
    memoryId: memory?.id || null,
    organizationId: artifact.orgId,
    name,
    contactName: String(record.contact_name || record.contactName || provenance.contact_name || '').trim(),
    email,
    fitRationale: String(record.fit_reason || record.fitRationale || provenance.fit_reason || '').trim(),
    outreachAngle: String(record.outreach_angle || record.outreachAngle || provenance.outreach_angle || '').trim(),
    evidenceRefs,
    record,
  };
}

function draftRecord(record, prospectId, artifactId) {
  return {
    id: artifactId,
    prospectId,
    recipient: normalizedEmail(record.recipient || record.to),
    subject: String(record.subject || '').trim(),
    body: String(record.body || record.text || '').trim(),
    evidenceRefs: [...new Set(asList(record.evidence_refs || record.evidenceRefs).map(String))],
    version: Number(record.version || 1),
  };
}

function receiptRecord(row) {
  const payload = artifactPayload(row);
  return {
    id: row.id,
    organizationId: row.orgId,
    executionId: String(payload.execution_id || row.workflowId),
    prospectId: String(payload.prospect_id || ''),
    touch: Number(payload.touch || 1),
    idempotencyKey: String(payload.idempotency_key || ''),
    providerMessageId: String(payload.provider_message_id || ''),
    providerThreadId: String(payload.provider_thread_id || ''),
    outboundActionId: payload.outbound_action_id || null,
    status: String(payload.status || row.status || 'sent'),
    sentAt: payload.sent_at || row.createdAt?.toISOString?.() || row.createdAt,
  };
}

export function createWorkflowEmailDomainStore({ prisma }) {
  if (!prisma) throw new Error('email_lifecycle_domain_store_prisma_required');

  const workflow = async (organizationId, executionId) => prisma.hqWorkflow.findFirst({
    where: { id: executionId, orgId: organizationId },
  });

  const artifacts = async (organizationId, executionId, types = []) => prisma.hqWorkflowArtifact.findMany({
    where: {
      workflowId: executionId,
      orgId: organizationId,
      ...(types.length ? { artifactType: { in: types } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const acceptedProspects = async ({ organizationId, executionId }) => {
    if (!await workflow(organizationId, executionId)) return [];
    const rows = await artifacts(organizationId, executionId, ['prospect_records']);
    const records = rows.flatMap((row) => asList(artifactPayload(row).records).map((record) => ({ row, record })));
    if (!records.length) return [];
    const memories = await prisma.memory.findMany({
      where: { orgId: organizationId, deletedAt: null, isLatest: true, sourcePlatform: 'hyperagents-prospect' },
      select: { id: true, title: true, provenance: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    const byId = new Map(memories.map((memory) => [String(memory.id), memory]));
    const byEmail = new Map(memories.map((memory) => [normalizedEmail(memory.provenance?.email), memory]).filter(([email]) => email));
    const byCompany = new Map(memories.map((memory) => [String(memory.provenance?.company || memory.title || '').replace(/^Prospect:\s*/i, '').trim().toLowerCase(), memory]).filter(([name]) => name));
    return records.map(({ row, record }) => {
      const memory = byId.get(String(record.memory_id || record.prospect_id || ''))
        || byEmail.get(normalizedEmail(record.email || record.to))
        || byCompany.get(String(record.company || record.name || '').trim().toLowerCase())
        || null;
      return prospectFromRecord(record, row, memory);
    }).filter((prospect) => prospect.name && prospect.email && prospect.fitRationale && prospect.outreachAngle && prospect.evidenceRefs.length);
  };

  const upsertArtifact = async ({ organizationId, executionId, artifactKey, artifactType, payload, sourceRefs = [], status = 'READY', externalRef = null }) => {
    const owner = await workflow(organizationId, executionId);
    if (!owner) throw new Error('email_lifecycle_workflow_not_found');
    return prisma.hqWorkflowArtifact.upsert({
      where: { workflowId_artifactKey: { workflowId: executionId, artifactKey } },
      create: { workflowId: executionId, orgId: organizationId, artifactKey, artifactType, status, payload, sourceRefs, externalRef },
      update: { artifactType, status, payload, sourceRefs, externalRef },
    });
  };

  const listDraftRows = async ({ organizationId, executionId, followUp = false }) => {
    const prospects = await acceptedProspects({ organizationId, executionId });
    const byEmail = new Map(prospects.map((item) => [item.email, item.id]));
    const byCompany = new Map(prospects.map((item) => [item.name.toLowerCase(), item.id]));
    const rows = await artifacts(organizationId, executionId, followUp
      ? ['email_follow_up'] : ['email_drafts', 'email_draft']);
    const output = [];
    for (const row of rows) {
      const payload = artifactPayload(row);
      const records = normalizedKind(row.artifactType) === 'email_drafts' ? asList(payload.records) : [payload];
      for (const record of records) {
        const prospectId = String(record.prospect_id || record.prospectId || '')
          || byEmail.get(normalizedEmail(record.recipient || record.to))
          || byCompany.get(String(record.prospect_company || record.company || '').trim().toLowerCase());
        if (!prospectId) continue;
        const draft = draftRecord(record, prospectId, row.id);
        if (draft.recipient && draft.subject && draft.body) output.push({ ...draft, organizationId, executionId, touch: Number(record.touch || (followUp ? 2 : 1)) });
      }
    }
    return output;
  };

  const store = {
    async listAcceptedProspects({ organizationId, workOrderId }) {
      return acceptedProspects({ organizationId, executionId: workOrderId });
    },
    async getAcceptedProspect({ organizationId, workOrderId, prospectId }) {
      return (await acceptedProspects({ organizationId, executionId: workOrderId }))
        .find((item) => item.id === prospectId) || null;
    },
    async upsertDraft(value) {
      const row = await upsertArtifact({
        organizationId: value.organizationId, executionId: value.executionId,
        artifactKey: `email-lifecycle:draft:${value.prospectId}:touch-1`, artifactType: 'email_draft',
        payload: { execution_id: value.executionId, prospect_id: value.prospectId, touch: 1, recipient: value.recipient, subject: value.subject, body: value.body, evidence_refs: value.evidenceRefs, version: value.version },
        sourceRefs: value.evidenceRefs,
      });
      return { ...draftRecord(row.payload, value.prospectId, row.id), organizationId: value.organizationId, executionId: value.executionId };
    },
    async listDrafts(input) { return listDraftRows(input); },
    async getDraft(input) { return (await listDraftRows(input)).find((row) => row.prospectId === input.prospectId) || null; },
    async upsertReceipt(value) {
      const row = await upsertArtifact({
        organizationId: value.organizationId, executionId: value.executionId,
        artifactKey: `email-lifecycle:receipt:${value.prospectId}:touch-${value.touch || 1}`,
        artifactType: 'email_delivery_receipt', status: String(value.status || 'sent').toUpperCase(),
        externalRef: value.providerMessageId,
        payload: { execution_id: value.executionId, prospect_id: value.prospectId, touch: value.touch || 1, idempotency_key: value.idempotencyKey, provider_message_id: value.providerMessageId, provider_thread_id: value.providerThreadId, outbound_action_id: value.outboundActionId || null, status: value.status || 'sent', sent_at: new Date().toISOString() },
      });
      return receiptRecord(row);
    },
    async listReceipts({ organizationId, executionId }) {
      return (await artifacts(organizationId, executionId, ['email_delivery_receipt'])).map(receiptRecord);
    },
    async getFollowUpDraft(input) {
      return (await listDraftRows({ ...input, followUp: true })).find((row) => row.prospectId === input.prospectId && row.touch === Number(input.touch)) || null;
    },
    async upsertFollowUpDraft(value) {
      const row = await upsertArtifact({
        organizationId: value.organizationId, executionId: value.executionId,
        artifactKey: `email-lifecycle:draft:${value.prospectId}:touch-${value.touch}`,
        artifactType: 'email_follow_up',
        payload: { execution_id: value.executionId, prospect_id: value.prospectId, touch: value.touch, recipient: value.recipient, subject: value.subject, body: value.body, evidence_refs: value.evidenceRefs, version: value.version },
        sourceRefs: value.evidenceRefs,
      });
      return { ...draftRecord(row.payload, value.prospectId, row.id), organizationId: value.organizationId, executionId: value.executionId, touch: value.touch };
    },
    async getFollowUpReceipt({ organizationId, executionId, prospectId, touch }) {
      return (await artifacts(organizationId, executionId, ['email_delivery_receipt'])).map(receiptRecord)
        .find((row) => row.prospectId === prospectId && row.touch === Number(touch)) || null;
    },
    async upsertFollowUpReceipt(value) { return store.upsertReceipt(value); },
  };
  return store;
}
