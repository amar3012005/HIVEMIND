#!/usr/bin/env node

import fs from 'fs';

const CONFIG = {
  apiUrl: process.env.HIVEMIND_API_URL || 'http://localhost:3000',
  apiKey: process.env.HIVEMIND_API_KEY || process.env.KEY || '',
  defaultProject: process.env.HIVEMIND_DEFAULT_PROJECT || null,
  defaultRecallSources: (process.env.HIVEMIND_DEFAULT_RECALL_SOURCES || 'codex').split(',').map((item) => item.trim()).filter(Boolean),
  defaultRecallTags: (process.env.HIVEMIND_DEFAULT_RECALL_TAGS || 'codex').split(',').map((item) => item.trim()).filter(Boolean),
};

function usage() {
  console.error(`Usage:
  node scripts/codex-hivemind.js remember "text to store" [--title "Title"] [--tags a,b] [--type fact] [--importance 0.7] [--project workspace]
  node scripts/codex-hivemind.js recall "query text" [--limit 5] [--project workspace] [--source codex,gmail] [--prefer-source codex,gmail] [--prefer-tag deploy,ops]
  node scripts/codex-hivemind.js session-save /absolute/or/relative/path/to/session.json

Environment:
  HIVEMIND_API_URL   default: http://localhost:3000
  HIVEMIND_API_KEY   required unless KEY is set
`);
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { flags, positionals };
}

async function apiCall(method, path, body) {
  if (!CONFIG.apiKey) {
    throw new Error('Missing HIVEMIND_API_KEY');
  }

  const response = await fetch(new URL(path, CONFIG.apiUrl), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error || raw || `HTTP ${response.status}`);
  }

  return data;
}

async function remember(args) {
  const { flags, positionals } = parseFlags(args);
  const content = positionals.join(' ').trim();
  if (!content) {
    throw new Error('remember requires content text');
  }

  const payload = {
    content,
    title: flags.title || undefined,
    memory_type: flags.type || 'fact',
    tags: typeof flags.tags === 'string' && flags.tags.length > 0 ? flags.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    importance_score: flags.importance ? Number(flags.importance) : 0.5,
    project: flags.project || CONFIG.defaultProject || undefined,
    source_platform: 'codex',
  };

  const result = await apiCall('POST', '/api/memories', payload);
  const memory = result.memory;
  console.log(JSON.stringify({
    ok: true,
    id: memory?.id,
    title: memory?.title,
    memory_type: memory?.memory_type,
    tags: memory?.tags || [],
    source: memory?.source,
    mutation: result.mutation || null,
  }, null, 2));
}

async function recall(args) {
  const { flags, positionals } = parseFlags(args);
  const query = positionals.join(' ').trim();
  if (!query) {
    throw new Error('recall requires query text');
  }

  const result = await apiCall('POST', '/api/recall', {
    query_context: query,
    max_memories: flags.limit ? Number(flags.limit) : 5,
    project: flags.project || CONFIG.defaultProject || undefined,
    source_platforms: typeof flags.source === 'string' ? flags.source.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
    preferred_project: flags.project || CONFIG.defaultProject || undefined,
    preferred_source_platforms: typeof flags['prefer-source'] === 'string'
      ? flags['prefer-source'].split(',').map((item) => item.trim()).filter(Boolean)
      : CONFIG.defaultRecallSources,
    preferred_tags: typeof flags['prefer-tag'] === 'string'
      ? flags['prefer-tag'].split(',').map((item) => item.trim()).filter(Boolean)
      : CONFIG.defaultRecallTags,
  });

  console.log(JSON.stringify({
    ok: true,
    count: result.memories?.length || 0,
    search_method: result.search_method || 'unknown',
    memories: (result.memories || []).map((memory) => ({
      id: memory.id,
      title: memory.title,
      memory_type: memory.memory_type,
      tags: memory.tags,
      source: memory.source,
      score: memory.score,
      vector_score: memory.vector_score,
      keyword_score: memory.keyword_score,
      graph_score: memory.graph_score,
      policy_score: memory.policy_score,
      preview: memory.content?.slice(0, 180),
    })),
    injectionText: result.injectionText || '',
  }, null, 2));
}

async function sessionSave(args) {
  const { positionals } = parseFlags(args);
  const filePath = positionals[0];
  if (!filePath) {
    throw new Error('session-save requires a JSON file path');
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const session = JSON.parse(raw);
  const result = await apiCall('POST', '/api/ingest', session);

  console.log(JSON.stringify({
    ok: true,
    jobId: result.jobId,
    status: result.status,
  }, null, 2));
}

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'remember':
      await remember(args);
      break;
    case 'recall':
      await recall(args);
      break;
    case 'session-save':
      await sessionSave(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
