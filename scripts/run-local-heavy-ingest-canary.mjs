import fs from 'node:fs/promises';
import path from 'node:path';

const apiBase = String(process.env.HIVEMIND_LOCAL_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
const userId = process.env.HIVEMIND_CANARY_USER_ID;
const orgId = process.env.HIVEMIND_CANARY_ORG_ID;
const timeoutMs = Number(process.env.HIVEMIND_CANARY_TIMEOUT_MS || 90 * 60 * 1000);
const files = process.argv.slice(2).map((value) => path.resolve(value));

if (!apiKey || !userId || !orgId) {
  throw new Error('HIVEMIND_MASTER_API_KEY, HIVEMIND_CANARY_USER_ID, and HIVEMIND_CANARY_ORG_ID are required');
}
if (files.length === 0) throw new Error('Pass one or more files to upload');

const headers = {
  Authorization: `Bearer ${apiKey}`,
  'X-HM-User-Id': userId,
  'X-HM-Org-Id': orgId,
};

async function readJson(response) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${payload?.error || payload?.message || 'request failed'}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function submit(file) {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), path.basename(file));
  form.append('tags', 'heavy-ingest-canary,1981-annual-report');
  form.append('targetScope', 'personal');
  form.append('ingestMode', 'both');
  form.append('async', 'true');
  if (process.env.HIVEMIND_CANARY_FORCE === 'true') form.append('force', 'true');
  const response = await fetch(`${apiBase}/api/knowledge/upload?async=true`, {
    method: 'POST', headers, body: form,
  });
  const payload = await readJson(response);
  const jobId = payload.job_id || response.headers.get('x-job-id');
  if (!jobId) throw new Error(`Upload for ${path.basename(file)} returned no job_id`);
  return { file, jobId, accepted: payload };
}

async function status(jobId) {
  return readJson(await fetch(`${apiBase}/api/knowledge/status?job_id=${encodeURIComponent(jobId)}`, { headers }));
}

function terminal(value) {
  return value === 'ready' || value === 'failed' || value === 'cancelled';
}

const admittedAt = Date.now();
const admissions = await Promise.allSettled(files.map(submit));
const accepted = [];
for (let index = 0; index < admissions.length; index += 1) {
  const result = admissions[index];
  if (result.status === 'fulfilled') {
    accepted.push(result.value);
    console.log(JSON.stringify({ event: 'accepted', file: path.basename(result.value.file), job_id: result.value.jobId,
      orchestration_mode: result.value.accepted.orchestration_mode || null, existing: Boolean(result.value.accepted.existing) }));
  } else {
    console.log(JSON.stringify({ event: 'admission_failed', file: path.basename(files[index]), error: result.reason?.message || String(result.reason) }));
  }
}
if (accepted.length !== files.length) throw new Error(`${files.length - accepted.length} upload admission(s) failed`);

const final = new Map();
const lastStage = new Map();
while (final.size < accepted.length && Date.now() - admittedAt < timeoutMs) {
  await Promise.all(accepted.filter(({ jobId }) => !final.has(jobId)).map(async ({ file, jobId }) => {
    try {
      const value = await status(jobId);
      const stageKey = `${value.status || ''}:${value.stage || ''}:${value.progress || 0}`;
      if (lastStage.get(jobId) !== stageKey) {
        lastStage.set(jobId, stageKey);
        console.log(JSON.stringify({ event: 'progress', file: path.basename(file), job_id: jobId,
          status: value.status, stage: value.stage, progress: value.progress,
          counts: value.counts || null, error: value.error || null }));
      }
      if (terminal(value.status)) final.set(jobId, { file, jobId, value });
    } catch (error) {
      console.log(JSON.stringify({ event: 'poll_error', file: path.basename(file), job_id: jobId, error: error.message }));
    }
  }));
  if (final.size < accepted.length) await new Promise((resolve) => setTimeout(resolve, 5000));
}

for (const admission of accepted) {
  if (!final.has(admission.jobId)) final.set(admission.jobId, { ...admission, value: { status: 'timeout' } });
}
const summary = [...final.values()].map(({ file, jobId, value }) => ({
  file: path.basename(file), job_id: jobId, status: value.status, stage: value.stage,
  document_id: value.document_id || null, memory_count: value.counts?.memories ?? value.memory_ids?.length ?? null,
  counts: value.counts || null, evidence_only: value.evidence_only ?? null,
  memory_generation_failed: value.memory_generation_failed ?? null, error: value.error || null,
}));
console.log(JSON.stringify({ event: 'final', elapsed_seconds: Math.round((Date.now() - admittedAt) / 1000), jobs: summary }, null, 2));
if (summary.some((job) => job.status !== 'ready')) process.exitCode = 1;
