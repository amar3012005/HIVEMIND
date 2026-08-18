#!/usr/bin/env node

/**
 * Provider-neutral OpenRouter rerank smoke benchmark.
 *
 * Uses only synthetic multilingual memory/evidence candidates. It measures
 * whether each model retains the required facts inside the visible answer
 * window and reports warm latency distribution. No tenant data is sent.
 */

const endpoint = String(process.env.RERANK_URL || 'https://openrouter.ai/api/v1/rerank').replace(/\/+$/, '');
const apiKey = process.env.RERANK_API_KEY || process.env.OPENROUTER_API_KEY;
const models = String(process.env.RERANK_BENCH_MODELS
  || 'voyageai/rerank-2.5,cohere/rerank-4-pro,cohere/rerank-4-fast,voyageai/rerank-2.5-lite,qwen/qwen3-reranker-8b')
  .split(',').map((value) => value.trim()).filter(Boolean);
const rounds = Math.max(1, Number(process.env.RERANK_BENCH_ROUNDS || 2));
const timeoutMs = Math.max(500, Number(process.env.RERANK_BENCH_TIMEOUT_MS || 8000));

if (!apiKey) throw new Error('RERANK_API_KEY or OPENROUTER_API_KEY is required');

const cases = [
  {
    name: 'exact_contract_detail_en',
    query: 'What is the contractual penalty for each day of service delay?',
    relevant: ['penalty'],
    documents: [
      ['overview', 'Nordwind operates turbines in the Hannover region.'],
      ['penalty', 'The agreed service window is 48 hours, with a penalty of 1,240 EUR per day of delay.'],
      ['price', 'The annual maintenance price is 48,000 EUR.'],
      ['unrelated', 'The employee handbook describes annual leave.'],
    ],
  },
  {
    name: 'product_inventory_de',
    query: 'Welche Solvis Produkte und Modelle gibt es?',
    relevant: ['heat-pumps', 'managers', 'boiler'],
    documents: [
      ['positioning', 'Solvis positioniert seine Systeme als Grundlage fuer Waerme und Sicherheit.'],
      ['heat-pumps', 'Zur Produktfamilie gehoeren die Waermepumpen SolvisLea, SolvisMia und SolvisPia.'],
      ['market', 'Der Waermepumpenmarkt wuchs im ersten Halbjahr.'],
      ['managers', 'SolvisBen und SolvisMax sind Energiemanager der Produktfamilie.'],
      ['boiler', 'SolvisLino ist der Pelletkessel im Solvis Sortiment.'],
      ['unrelated', 'Ein Roman spielt waehrend einer Gartenparty.'],
    ],
  },
  {
    name: 'retention_review_es',
    query: 'Cual es el periodo de retencion y cuando ocurre la revision?',
    relevant: ['retention'],
    documents: [
      ['retention', 'La politica conserva los registros durante nueve meses y exige una revision trimestral.'],
      ['security', 'El acceso requiere autenticacion multifactor.'],
      ['old-policy', 'Una propuesta anterior sugeria seis meses, pero fue reemplazada.'],
      ['unrelated', 'La oficina abre de lunes a viernes.'],
    ],
  },
  {
    name: 'identifier_ar',
    query: 'ما هو معرف العقد العربي؟',
    relevant: ['arabic-id'],
    documents: [
      ['latin-id', 'The English contract identifier is 9876.'],
      ['arabic-id', 'معرف العقد المعتمد هو ٩٨٧٦ والمدير المسؤول هو ليلى منصور.'],
      ['manager', 'ليلى منصور تدير برنامج المراجعة السنوية.'],
      ['unrelated', 'تصف الوثيقة سياسة السفر الداخلية.'],
    ],
  },
  {
    name: 'negation_and_competing_values',
    query: 'Which plan explicitly does not include offline mode?',
    relevant: ['basic-negation'],
    documents: [
      ['pro-positive', 'The Pro plan includes offline mode and local synchronization.'],
      ['basic-negation', 'The Basic plan does not include offline mode; it requires a network connection.'],
      ['basic-general', 'The Basic plan includes ten projects and email support.'],
      ['proposal', 'A discarded proposal suggested adding offline mode to every plan.'],
    ],
  },
  {
    name: 'source_specific_filename',
    query: 'What does the file Transformation White Paper 20251106.pdf say about HEMS interfaces?',
    relevant: ['named-source'],
    documents: [
      ['other-source', 'Branding Sketch.pdf describes the emotional brand position.'],
      ['named-source', 'Transformation White Paper 20251106.pdf: Solvis HEMS supports EEBus control, photovoltaic surplus handling, and flexible heat-pump power management.'],
      ['generic-hems', 'A generic HEMS coordinates household energy loads.'],
      ['unrelated', 'Meeting Notes.pdf records the next marketing workshop.'],
    ],
  },
];

// Exercise the production pool ceiling, including a small exact fact that the
// pre-rank lanes placed late. This catches models whose attractive latency on
// tiny examples collapses when the real mixed pool is submitted.
cases.push({
  name: 'production_pool_150',
  query: 'Which controller supports the E3DC meter and what is its exact service code?',
  relevant: ['late-exact-controller'],
  documents: Array.from({ length: 150 }, (_, index) => (
    index === 137
      ? ['late-exact-controller', 'The SolvisTim controller supports the E3DC meter. Its exact service code is ST-E3DC-48.']
      : [`distractor-${index}`, `General heating-system passage ${index}: modular storage, installation guidance, and routine maintenance.`]
  )),
});

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const dcg = (bits) => bits.reduce((sum, bit, index) => sum + (bit ? 1 / Math.log2(index + 2) : 0), 0);

async function runOne(model, testCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout_${timeoutMs}ms`)), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        query: testCase.query,
        documents: testCase.documents.map(([, text]) => text),
        top_n: testCase.documents.length,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`http_${response.status}:${body?.error?.message || body?.message || 'unknown'}`);
    const rankedIds = (body.results || []).map((row) => testCase.documents[row.index]?.[0]).filter(Boolean);
    const relevant = new Set(testCase.relevant);
    const k = relevant.size;
    const visible = rankedIds.slice(0, k);
    const hits = visible.filter((id) => relevant.has(id)).length;
    const firstRelevant = rankedIds.findIndex((id) => relevant.has(id));
    const ideal = Array.from({ length: k }, () => 1);
    const actual = rankedIds.slice(0, k).map((id) => relevant.has(id));
    return {
      ok: true,
      latency_ms: Math.round(performance.now() - startedAt),
      recall_at_k: hits / k,
      reciprocal_rank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
      ndcg_at_k: dcg(actual) / dcg(ideal),
      ranked_ids: rankedIds,
      provider: body.provider || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const report = [];
for (const model of models) {
  const results = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const testCase of cases) {
      try {
        results.push({ case: testCase.name, round, ...(await runOne(model, testCase)) });
      } catch (error) {
        results.push({ case: testCase.name, round, ok: false, error: error?.message || String(error) });
      }
    }
  }
  const passed = results.filter((row) => row.ok);
  const latencies = passed.map((row) => row.latency_ms);
  report.push({
    model,
    requests: results.length,
    successful: passed.length,
    quality: {
      mean_recall_at_k: passed.length ? Number((passed.reduce((sum, row) => sum + row.recall_at_k, 0) / passed.length).toFixed(4)) : 0,
      mean_mrr: passed.length ? Number((passed.reduce((sum, row) => sum + row.reciprocal_rank, 0) / passed.length).toFixed(4)) : 0,
      mean_ndcg_at_k: passed.length ? Number((passed.reduce((sum, row) => sum + row.ndcg_at_k, 0) / passed.length).toFixed(4)) : 0,
    },
    latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    providers: [...new Set(passed.map((row) => row.provider).filter(Boolean))],
    failures: results.filter((row) => !row.ok),
    cases: results,
  });
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), rounds, cases: cases.length, report }, null, 2));
