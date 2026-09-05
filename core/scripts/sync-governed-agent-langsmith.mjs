/**
 * Publish the redacted, fixture-only governed-agent regression set to
 * LangSmith. This is intentionally separate from production startup: it is a
 * controlled developer command and never uploads connector receipts or live
 * user conversations.
 */
import { readFile } from 'node:fs/promises';
import { Client } from 'langsmith';

const datasetName = process.env.LANGSMITH_GOVERNED_DATASET || 'governed-agent-regression-v1';
const projectName = process.env.LANGSMITH_PROJECT || 'singulance-governed-agent-canary';
const apiKey = process.env.LANGSMITH_API_KEY;
if (!apiKey) throw new Error('LANGSMITH_API_KEY is required');

const casesPath = new URL('../evals/governed-agent-regression.json', import.meta.url);
const cases = JSON.parse(await readFile(casesPath, 'utf8'));
const client = new Client({
  apiKey,
  apiUrl: process.env.LANGSMITH_ENDPOINT || undefined,
  hideInputs: true,
  hideOutputs: true,
});

let dataset;
if (await client.hasDataset({ datasetName })) {
  dataset = await client.readDataset({ datasetName });
} else {
  dataset = await client.createDataset(datasetName, {
    description: 'Fixture-only governed connected-tool trajectory regressions. No real connector data.',
    dataType: 'kv',
    metadata: { runtime: 'langgraph-governed-v2', project: projectName, redacted: true },
  });
}

const existing = new Set();
// LangSmith's EU API currently caps this page size at 100. The iterator
// transparently paginates, so the smaller limit is both portable and complete.
for await (const example of client.listExamples({ datasetId: dataset.id, limit: 100 })) {
  if (example.metadata?.case_id) existing.add(String(example.metadata.case_id));
}
const uploads = cases.filter(item => !existing.has(item.id)).map(item => ({
  dataset_id: dataset.id,
  inputs: { message: item.inputs.message, language: item.inputs.language, history_turns: item.inputs.history_turns },
  outputs: item.outputs,
  metadata: { case_id: item.id, fixture_only: true, redacted: true },
  split: ['regression', 'governed-agent'],
}));
if (uploads.length) await client.createExamples(uploads);
await client.flush();
console.log(JSON.stringify({ ok: true, dataset: dataset.name, dataset_id: dataset.id, created: uploads.length, existing: existing.size }));
