#!/usr/bin/env node

// Self-cleaning cross-mode semantic parity canary. The same mixed multilingual
// corpus is ingested in `both` mode, recalled in three languages, and answered
// through native chat with use_tools=false. It validates evidence visibility,
// promoted memory visibility, broad-answer coverage, citations and residency.

import crypto from 'node:crypto';
import { getPrismaClient } from '../src/db/prisma.js';
import { orgIsRemote } from '../src/vector/mneme/driver.js';
import { agentFor } from '../src/vector/mneme/remote-backend.js';

const orgId = String(process.env.STORAGE_CANARY_ORG_ID || '').trim();
const userId = String(process.env.STORAGE_CANARY_USER_ID || '').trim();
const baseUrl = String(process.env.STORAGE_CANARY_CORE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
if (!orgId || !userId || process.env.STORAGE_CANARY_CONFIRM !== 'DELETE_CANARY_DATA') {
  throw new Error('Set STORAGE_CANARY_ORG_ID, STORAGE_CANARY_USER_ID, and STORAGE_CANARY_CONFIRM=DELETE_CANARY_DATA');
}

const prisma = getPrismaClient();
const suffix = crypto.randomBytes(5).toString('hex');
const company = `Asteria${suffix}`;
const productA = `LumenCore${suffix}`;
const productB = `ThermaVault${suffix}`;
const contract = `٩٨٧٦-${suffix}`;
const filename = `storage-multilingual-${suffix}.md`;
const rawKey = `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
const startedAt = Date.now();
const headers = { authorization: `Bearer ${rawKey}`, 'x-hm-user-id': userId, 'x-hm-org-id': orgId };
let keyId;
let documentId;
let jobId;

const content = `# ${company} product and contract brief

${company} manufactures the product ${productA}, a modular controller rated for 73 devices.

Das Produkt ${productB} ist ein Wärmespeicher mit einer Kapazität von 145 Kilowattstunden.

El contrato de soporte exige una retención de nueve meses y una revisión cada tres meses.

رقم العقد الرسمي هو ${contract}، ومدير البرنامج هو ليلى منصور.
`;

async function json(response, allowFailure = false) {
  const body = await response.json().catch(() => ({}));
  if (!allowFailure && !response.ok) throw new Error(`${response.status}:${JSON.stringify(body)}`);
  return body;
}

async function recall(query) {
  return json(await fetch(`${baseUrl}/api/recall`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query, mode: 'quick', limit: 15, debug_timing: true }),
  }));
}

function corpusText(result) {
  return [...(result.memories || []), ...(result.evidence || [])]
    .map((row) => String(row.content || row.snippet || '')).join('\n');
}

function foldForComparison(value) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const easternArabicIndic = '۰۱۲۳۴۵۶۷۸۹';
  return String(value || '').normalize('NFKC')
    .replace(/[٠-٩]/g, (digit) => String(arabicIndic.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(easternArabicIndic.indexOf(digit)))
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[\s-]+/gu, '')
    .toLocaleLowerCase();
}

async function cleanup() {
  if (documentId) {
    await fetch(`${baseUrl}/api/knowledge/document`, {
      method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: documentId, filename }),
    }).catch(() => {});
    documentId = null;
  }
  if (jobId) {
    await prisma.knowledgeIngestJob.deleteMany({ where: { id: jobId, orgId, userId } }).catch(() => {});
    jobId = null;
  }
}

try {
  const key = await prisma.apiKey.create({ data: {
    userId, orgId, name: 'storage-multilingual-summary-canary',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12), scopes: ['memory:read', 'memory:write', 'admin'],
  } });
  keyId = key.id;

  const form = new FormData();
  form.set('file', new Blob([content], { type: 'text/markdown' }), filename);
  form.set('targetScope', 'organization');
  form.set('ingestMode', 'both');
  form.set('smart', 'true');
  const admitted = await json(await fetch(`${baseUrl}/api/knowledge/upload`, { method: 'POST', headers, body: form }));
  jobId = admitted.job_id;
  let status;
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    status = await json(await fetch(`${baseUrl}/api/knowledge/status?job_id=${encodeURIComponent(admitted.job_id)}`, { headers }));
    if (['ready', 'failed', 'dead'].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (status?.status !== 'ready') throw new Error(`ingestion_not_ready:${JSON.stringify(status)}`);
  documentId = status.document_id;
  if (!(status.memory_ids || []).length) throw new Error(`no_promoted_memories:${JSON.stringify(status)}`);

  const cases = [
    { language: 'de', query: `Welche Produkte stellt ${company} her und welche Kapazität hat ${productB}?`, expected: [productA, productB, '145'] },
    { language: 'es', query: `¿Cuál es el plazo de retención del contrato de ${company}?`, expected: ['nueve meses'] },
    { language: 'ar', query: `ما هو رقم العقد الرسمي لشركة ${company}؟`, expected: [contract] },
  ];
  const recallResults = [];
  for (const item of cases) {
    const result = await recall(item.query);
    const recallShape = {
      memories: result.memories?.length || 0,
      evidence: result.evidence?.length || 0,
      results: result.results?.length || 0,
      cutoff_reason: result.cutoff_reason || null,
      latency_ms: result.latency_ms || result.timing_ms || null,
      stage_breakdown: result.stage_breakdown || null,
    };
    const text = corpusText(result).toLocaleLowerCase();
    for (const expected of item.expected) {
      if (!text.includes(expected.toLocaleLowerCase())) {
        throw new Error(`${item.language}_recall_missing:${expected}:${JSON.stringify(recallShape)}`);
      }
    }
    if (!(result.evidence || []).length) {
      throw new Error(`${item.language}_evidence_lane_missing:${JSON.stringify(recallShape)}`);
    }
    recallResults.push({
      language: item.language,
      memories: result.memories.length,
      evidence: result.evidence.length,
      timing_ms: result.timing_ms || result.recall_timing_ms || null,
      ranked_ids: (result.ranked_candidates || result.results || []).slice(0, 15).map((row) => row.id || row.segment_id || row.segmentId).filter(Boolean),
    });
  }
  if (!recallResults.some((result) => result.memories > 0)) {
    throw new Error(`promoted_memory_lane_never_visible:${JSON.stringify(recallResults)}`);
  }

  const chat = await json(await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `Give me a detailed summary of every ${company} product, capacity, retention period, review cadence, official contract identifier, and program manager found in my knowledge.`,
      use_tools: false, stream: false,
    }),
  }));
  const answer = String(chat.response || chat.answer || '');
  const required = [
    [productA], ['73'], [productB], ['145'], ['nine months', 'nine month'], ['three months'],
    [contract, `9876-${suffix}`],
    ['ليلى منصور', 'Leila Mansour', 'Layla Mansour'],
  ];
  const foldedAnswer = foldForComparison(answer);
  const missing = required
    .filter((alternatives) => !alternatives.some((value) => foldedAnswer.includes(foldForComparison(value))))
    .map((alternatives) => alternatives[0]);
  if (missing.length) throw new Error(`broad_chat_missing:${JSON.stringify({
    missing, answer_chars: answer.length, answer, recall: recallResults,
    chat_sources: (chat.citations || chat.sources || []).length,
    execution: chat.execution || null,
  })}`);
  const citations = chat.citations || chat.sources || [];
  if (!Array.isArray(citations) || citations.length === 0) throw new Error('broad_chat_uncited');

  const remote = orgIsRemote(orgId);
  const embedded = remote && agentFor(orgId)?.url === 'local:';
  const central = {
    documents: await prisma.knowledgeDocument.count({ where: { orgId, id: documentId } }),
    segments: await prisma.knowledgeSegment.count({ where: { orgId, documentId } }),
    memories: await prisma.memory.count({ where: { orgId, id: { in: status.memory_ids || [] } } }),
  };
  if (remote && (central.documents || central.segments || central.memories)) throw new Error(`residency_violation:${JSON.stringify(central)}`);
  if (!remote && (central.documents !== 1 || central.segments < 1 || central.memories < 1)) throw new Error(`managed_missing:${JSON.stringify(central)}`);

  await cleanup();
  console.log(JSON.stringify({
    ok: true,
    storage_mode: embedded ? 'amr_embedded' : remote ? 'byod' : 'managed',
    promoted_memories: status.memory_ids.length,
    recall: recallResults,
    chat_answer_chars: answer.length,
    chat_citations: citations.length,
    chat_grounded: chat.grounded ?? null,
    central,
    hard_deleted: true,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }));
} finally {
  await cleanup().catch(() => {});
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } }).catch(() => {});
  await prisma.$disconnect();
}
