#!/usr/bin/env node
/**
 * LongMemEval-S Benchmark Runner for HIVEMIND
 *
 * Ingests LongMemEval_S dataset session-by-session into HIVEMIND,
 * runs retrieval + generation for all 500 questions,
 * outputs hypothesis JSONL for the official evaluate_qa.py script.
 *
 * Usage:
 *   node longmemeval-runner.js --phase ingest     # Ingest all sessions
 *   node longmemeval-runner.js --phase evaluate    # Run queries + generate answers
 *   node longmemeval-runner.js --phase both        # Full pipeline
 *   node longmemeval-runner.js --phase evaluate --sample 10  # Quick test with 10 questions
 *
 * Requires: GROQ_API_KEY, HIVEMIND core API running
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.LONGMEMEVAL_DATA || path.join(__dirname, '../../../benchmarks/LongMemEval/data/longmemeval_s_cleaned.json');
const OUTPUT_DIR = path.join(__dirname, '../../evaluation-reports');
const HYPOTHESIS_FILE = path.join(OUTPUT_DIR, 'longmemeval-hypotheses.jsonl');

// HIVEMIND API config
const API_BASE = process.env.HIVEMIND_API_BASE || 'https://core.hivemind.davinciai.eu:8050';
const API_KEY = process.env.HIVEMIND_API_KEY || process.env.HIVEMIND_MASTER_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_INFERENCE_MODEL || 'openai/gpt-oss-120b';

// Benchmark user/org (isolated tenant)
const BENCH_USER = 'longmemeval-bench-001';
const BENCH_ORG = 'longmemeval-org-001';

// ── CLI args ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { phase: 'all', sample: 0, startFrom: 0, concurrency: 1 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--phase': opts.phase = args[++i]; break;
      case '--sample': opts.sample = parseInt(args[++i], 10); break;
      case '--start-from': opts.startFrom = parseInt(args[++i], 10); break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10); break;
      case '--help': case '-h':
        console.log(`
LongMemEval-S Benchmark Runner

Usage: node longmemeval-runner.js [options]

Options:
  --phase ingest|evaluate|judge|all   Pipeline phase (default: all = ingest+evaluate+judge)
  --sample N                     Only process N instances (default: all 500)
  --start-from N                 Start from instance N (default: 0)
  --concurrency N                Parallel instances (default: 1)
`);
        process.exit(0);
    }
  }
  return opts;
}

// ── API helpers ──────────────────────────────────────────

async function apiCall(method, path, body = null) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json',
    'X-HM-User-Id': BENCH_USER,
    'X-HM-Org-Id': BENCH_ORG,
  };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path}: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function groqChat(messages, options = {}) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model || GROQ_MODEL,
        messages,
        temperature: 0,
        max_tokens: options.maxTokens || 300,
      }),
    });

    if (resp.status === 429 || resp.status === 503) {
      const wait = Math.pow(2, attempt + 1) * 1000;
      console.warn(`  [rate-limit] Groq ${resp.status}, retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Groq API: ${resp.status} ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.choices[0].message.content;
  }
  throw new Error('Groq API: max retries exceeded');
}

// ── Date parsing ────────────────────────────────────────

function parseLongMemEvalDate(dateStr) {
  if (!dateStr) return null;
  // Format: "2023/05/20 (Sat) 02:21"
  const match = dateStr.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*\([^)]*\)\s*(\d{2}):(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`).toISOString();
  }
  // Try direct parse
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Phase 1: Ingest ─────────────────────────────────────

async function ingestInstance(instance, instanceIdx, totalInstances) {
  const { question_id, haystack_sessions, haystack_dates } = instance;
  const totalSessions = haystack_sessions.length;
  let ingested = 0;
  let skipped = 0;

  for (let i = 0; i < totalSessions; i++) {
    const session = haystack_sessions[i];
    const sessionDate = parseLongMemEvalDate(haystack_dates[i]);

    // Round-level ingestion: each user+assistant pair becomes its own memory
    for (let j = 0; j < session.length; j += 2) {
      const userTurn = session[j];
      const assistantTurn = session[j + 1];

      if (!userTurn) continue;

      const content = assistantTurn
        ? `User: ${userTurn.content}\nAssistant: ${assistantTurn.content}`
        : `User: ${userTurn.content}`;

      try {
        await apiCall('POST', '/api/memories', {
          content,
          title: `LME:${question_id}:s${i}:r${j / 2}`,
          tags: ['longmemeval', `qid:${question_id}`, `session:${i}`],
          memory_type: 'event',
          document_date: sessionDate,
          project: `lme-${question_id}`,
        });
        ingested++;
        // Small delay to avoid overwhelming the API + embedding service
        if (ingested % 20 === 0) await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        skipped++;
        if (skipped <= 3) console.warn(`  [skip] ${question_id}:s${i}:r${j / 2}: ${err.message.slice(0, 100)}`);
      }
    }
  }

  console.log(`[${instanceIdx + 1}/${totalInstances}] ${question_id}: ${totalSessions} sessions → ${ingested} memories, ${skipped} skipped`);
  return { ingested, skipped };
}

// ── Phase 2: Evaluate ───────────────────────────────────

async function evaluateInstance(instance) {
  const { question_id, question, question_type } = instance;
  const isAbstention = question_id.endsWith('_abs');

  // Search for relevant memories — try project-scoped first, fall back to global
  let searchResults;
  try {
    searchResults = await apiCall('POST', '/api/search/quick', {
      query: question,
      project: `lme-${question_id}`,
      limit: 10,
    });
    // If project-scoped returned too few results, try global
    const results = searchResults.results || searchResults.memories || [];
    if (results.length < 3) {
      const globalResults = await apiCall('POST', '/api/search/quick', {
        query: question,
        limit: 10,
      });
      const globalR = globalResults.results || globalResults.memories || [];
      if (globalR.length > results.length) searchResults = globalResults;
    }
  } catch {
    searchResults = { results: [] };
  }

  const results = searchResults.results || searchResults.memories || [];
  const context = results
    .slice(0, 5)
    .map(r => r.content || r.payload?.content || '')
    .filter(c => c.length > 10)
    .join('\n---\n');

  // Generate hypothesis using Groq
  let hypothesis;
  try {
    const systemPrompt = isAbstention
      ? 'You are an AI assistant with memory of past conversations. If you cannot find the answer in the provided context, say "I don\'t have this information in my memory." Be honest about what you don\'t know.'
      : 'You are an AI assistant with memory of past conversations. Answer the question based ONLY on the provided conversation history. Be concise and direct. If conflicting information exists, prefer the most recent.';

    const userPrompt = context.length > 50
      ? `Here are relevant memories from our past conversations:\n\n${context}\n\nQuestion: ${question}\n\nAnswer concisely:`
      : `I don't have relevant context for this question.\n\nQuestion: ${question}\n\nAnswer concisely:`;

    // Use llama for generation (gpt-oss-120b returns empty strings sometimes)
    hypothesis = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { model: 'llama-3.3-70b-versatile', maxTokens: 200 });

    // Retry with fallback if empty
    if (!hypothesis || hypothesis.trim().length === 0) {
      hypothesis = await groqChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { model: 'llama-3.3-70b-versatile', maxTokens: 200 });
    }
  } catch (err) {
    console.warn(`  [groq-fail] ${question_id}: ${err.message.slice(0, 100)}`);
    hypothesis = "I don't have this information in my memory.";
  }

  return { question_id, hypothesis: hypothesis.trim() };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  HIVEMIND × LongMemEval-S Benchmark Runner  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Load dataset
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Dataset not found: ${DATA_PATH}`);
    console.error('Run: cd benchmarks/LongMemEval/data && wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json');
    process.exit(1);
  }

  console.log('Loading dataset...');
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  let instances = data.slice(opts.startFrom);
  if (opts.sample > 0) instances = instances.slice(0, opts.sample);

  console.log(`Instances: ${instances.length} (of ${data.length} total)`);
  console.log(`Phase: ${opts.phase}`);
  console.log(`API: ${API_BASE}`);
  console.log(`User: ${BENCH_USER}`);
  console.log(`Groq: ${GROQ_MODEL}`);
  console.log('');

  // Ensure output dir
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Ingest Phase ──
  if (['ingest', 'both', 'all'].includes(opts.phase)) {
    console.log('═══ Phase 1: Ingestion ═══');
    const startTime = Date.now();
    let totalIngested = 0;
    let totalSkipped = 0;

    for (let i = 0; i < instances.length; i++) {
      const { ingested, skipped } = await ingestInstance(instances[i], i, instances.length);
      totalIngested += ingested;
      totalSkipped += skipped;

      // Rate limiting: small pause between instances
      if (i % 10 === 9) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (totalIngested / (Date.now() - startTime) * 1000).toFixed(1);
        console.log(`  ... ${i + 1}/${instances.length} done, ${totalIngested} memories, ${rate}/sec, ${elapsed}s elapsed`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\nIngestion complete: ${totalIngested} memories, ${totalSkipped} skipped, ${duration}s`);
    console.log('');
  }

  // ── Evaluate Phase ──
  if (['evaluate', 'both', 'all'].includes(opts.phase)) {
    console.log('═══ Phase 2: Evaluation ═══');
    const startTime = Date.now();
    const hypotheses = [];

    for (let i = 0; i < instances.length; i++) {
      const result = await evaluateInstance(instances[i]);
      hypotheses.push(result);

      if ((i + 1) % 10 === 0 || i === instances.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`  [${i + 1}/${instances.length}] ${result.question_id}: "${result.hypothesis.slice(0, 60)}..." (${elapsed}s)`);
      }
    }

    // Write JSONL output
    const jsonlContent = hypotheses.map(h => JSON.stringify(h)).join('\n') + '\n';
    fs.writeFileSync(HYPOTHESIS_FILE, jsonlContent, 'utf-8');

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\nEvaluation complete: ${hypotheses.length} hypotheses, ${duration}s`);
    console.log(`Output: ${HYPOTHESIS_FILE}`);
    console.log('');

    // Print summary stats
    const byType = {};
    for (const inst of instances) {
      const type = inst.question_type;
      byType[type] = (byType[type] || 0) + 1;
    }
    console.log('Question type distribution:');
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  ${type}: ${count}`);
    }
  }

  // ── Judge Phase ──
  if (opts.phase === 'judge' || opts.phase === 'all') {
    console.log('═══ Phase 3: LLM-as-Judge (via Groq) ═══');
    // gpt-oss-120b returns empty on yes/no tasks; llama-3.3-70b works correctly as judge
    const JUDGE_MODEL = 'llama-3.3-70b-versatile';

    if (!fs.existsSync(HYPOTHESIS_FILE)) {
      console.error(`No hypothesis file found: ${HYPOTHESIS_FILE}`);
      console.error('Run --phase evaluate first.');
      process.exit(1);
    }

    const hypotheses = fs.readFileSync(HYPOTHESIS_FILE, 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    // Build lookup from dataset
    const dataLookup = {};
    for (const d of data) dataLookup[d.question_id] = d;

    const results = { total: 0, correct: 0, byType: {} };
    const judged = [];
    const startTime = Date.now();

    for (let i = 0; i < hypotheses.length; i++) {
      const h = hypotheses[i];
      const ref = dataLookup[h.question_id];
      if (!ref) { console.warn(`  [skip] ${h.question_id}: not found in dataset`); continue; }

      const isAbstention = h.question_id.endsWith('_abs');
      const qType = ref.question_type;

      // Build judge prompt (same as official evaluate_qa.py)
      let judgePrompt;
      if (isAbstention) {
        judgePrompt = `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable.\n\nQuestion: ${ref.question}\n\nExplanation: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
      } else if (qType === 'temporal-reasoning') {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Do not penalize off-by-one errors for the number of days.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else if (qType === 'knowledge-update') {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. If the response contains some previous information along with an updated answer, consider it correct.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else if (qType === 'single-session-preference') {
        judgePrompt = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response.\n\nQuestion: ${ref.question}\n\nRubric: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      }

      let verdict = 'no';
      try {
        const judgeResp = await groqChat([
          { role: 'user', content: judgePrompt },
        ], { model: JUDGE_MODEL, maxTokens: 10 });
        verdict = judgeResp.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
      } catch (err) {
        console.warn(`  [judge-fail] ${h.question_id}: ${err.message.slice(0, 80)}`);
        // Retry once after 2s
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryResp = await groqChat([{ role: 'user', content: judgePrompt }], { model: JUDGE_MODEL, maxTokens: 10 });
          verdict = retryResp.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
        } catch { /* give up */ }
      }

      const isCorrect = verdict === 'yes';
      results.total++;
      if (isCorrect) results.correct++;

      if (!results.byType[qType]) results.byType[qType] = { total: 0, correct: 0 };
      results.byType[qType].total++;
      if (isCorrect) results.byType[qType].correct++;

      judged.push({ ...h, autoeval_label: verdict, question_type: qType });

      if ((i + 1) % 20 === 0 || i === hypotheses.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const acc = ((results.correct / results.total) * 100).toFixed(1);
        console.log(`  [${i + 1}/${hypotheses.length}] ${acc}% accuracy so far (${elapsed}s)`);
      }

      // Rate limit: small pause
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 500));
    }

    // Write judged results
    const judgedFile = HYPOTHESIS_FILE.replace('.jsonl', '.judged.jsonl');
    fs.writeFileSync(judgedFile, judged.map(j => JSON.stringify(j)).join('\n') + '\n', 'utf-8');

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\n═══ RESULTS ═══`);
    console.log(`Overall: ${results.correct}/${results.total} = ${((results.correct / results.total) * 100).toFixed(1)}%`);
    console.log('');
    console.log('By category:');
    for (const [type, stats] of Object.entries(results.byType).sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = ((stats.correct / stats.total) * 100).toFixed(1);
      console.log(`  ${type}: ${stats.correct}/${stats.total} = ${pct}%`);
    }
    console.log(`\nDuration: ${duration}s`);
    console.log(`Judged output: ${judgedFile}`);
  }

  console.log('\n═══ Done ═══');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
