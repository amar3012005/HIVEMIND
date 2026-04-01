#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const CONFIG = {
  bin: process.env.NOTEBOOKLM_BIN || 'notebooklm',
  home: process.env.NOTEBOOKLM_HOME || `${process.env.HOME || '.'}/.notebooklm`,
  profile: process.env.NOTEBOOKLM_PROFILE || 'default',
  defaultNotebookTitle: process.env.NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE || 'Second Mind',
  defaultNotebookId: process.env.NOTEBOOKLM_DEFAULT_NOTEBOOK_ID || null,
  autoCreateDefaultNotebook: process.env.NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK === '1',
  timeoutMs: Number(process.env.NOTEBOOKLM_TIMEOUT_MS || 120000),
  researchTimeoutMs: Number(process.env.NOTEBOOKLM_RESEARCH_TIMEOUT_MS || 600000),
  stateFile: process.env.NOTEBOOKLM_STATE_FILE || path.resolve(process.cwd(), '.agents/notebooklm-codex.json'),
};

function usage() {
  console.error(`Usage:
  node scripts/codex-notebooklm.js status
  node scripts/codex-notebooklm.js notebooks
  node scripts/codex-notebooklm.js create "Notebook title"
  node scripts/codex-notebooklm.js ask "Question" [--notebook <id|title>] [--remember] [--no-state] [--source src1 --source src2] [--save-note] [--note-title "Title"]
  node scripts/codex-notebooklm.js add-source "url-or-text-or-path" [--notebook <id|title>] [--no-state] [--type url|text|file|youtube] [--title "Title"]
  node scripts/codex-notebooklm.js research "Query" [--notebook <id|title>] [--no-state] [--from web|drive] [--mode fast|deep] [--import-all]
  node scripts/codex-notebooklm.js second-mind "Question" [--notebook <id|title>] [--remember] [--no-state] [--source ...] [--source-file path] [--research "Query"] [--from web|drive] [--mode fast|deep] [--save-note] [--note-title "Title"]
  node scripts/codex-notebooklm.js register-connector
  node scripts/codex-notebooklm.js login
  node scripts/codex-notebooklm.js bootstrap [--notebook <id|title>] [--remember] [--no-state]

Environment:
  NOTEBOOKLM_BIN                           default: notebooklm
  NOTEBOOKLM_HOME                          default: ~/.notebooklm
  NOTEBOOKLM_PROFILE                       default: default
  NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE        default: Second Mind
  NOTEBOOKLM_DEFAULT_NOTEBOOK_ID           optional override
  NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK   default: 0
  NOTEBOOKLM_TIMEOUT_MS                    default: 120000
  NOTEBOOKLM_RESEARCH_TIMEOUT_MS           default: 600000
  NOTEBOOKLM_STATE_FILE                    default: .agents/notebooklm-codex.json
`);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { flags, positionals };
}

function run(command, args, { timeoutMs = CONFIG.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NOTEBOOKLM_HOME: CONFIG.home,
        NOTEBOOKLM_PROFILE: CONFIG.profile,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGTERM');
      reject(new Error(`NotebookLM timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `NotebookLM exited with code ${code}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function runInteractive(command, args, { timeoutMs = CONFIG.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NOTEBOOKLM_HOME: CONFIG.home,
        NOTEBOOKLM_PROFILE: CONFIG.profile,
      },
      stdio: 'inherit',
    });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGTERM');
      reject(new Error(`NotebookLM interactive command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`NotebookLM exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readState() {
  try {
    if (!fs.existsSync(CONFIG.stateFile)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  ensureDir(CONFIG.stateFile);
  const current = readState();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG.stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function extractSourceList(flags) {
  const values = Array.isArray(flags.source) ? flags.source : flags.source ? [flags.source] : [];
  return values.filter(Boolean);
}

function looksLikeNotebookId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

async function listNotebooks() {
  const output = await run(CONFIG.bin, ['list', '--json']);
  const parsed = parseJson(output);
  return Array.isArray(parsed?.notebooks) ? parsed.notebooks : [];
}

async function findNotebookRecord(reference) {
  if (!reference) return null;
  const trimmed = String(reference).trim();
  if (!trimmed) return null;

  const notebooks = await listNotebooks();
  if (looksLikeNotebookId(trimmed)) {
    return notebooks.find(item => item.id === trimmed) || { id: trimmed, title: null };
  }

  const exact = notebooks.find(item => item.title === trimmed);
  if (exact) return exact;

  const caseInsensitive = notebooks.find(item => item.title?.toLowerCase() === trimmed.toLowerCase());
  if (caseInsensitive) return caseInsensitive;

  const partial = notebooks.find(item => item.title?.toLowerCase().includes(trimmed.toLowerCase()));
  if (partial) return partial;

  return null;
}

async function resolveNotebookId(flags) {
  const explicitNotebook = flags.notebook || flags['notebook-title'] || flags['notebook-id'] || null;
  if (explicitNotebook) {
    const record = await findNotebookRecord(explicitNotebook);
    if (record?.id) {
      if (flags.remember) {
        writeState({
          notebookId: record.id,
          notebookTitle: record.title || String(explicitNotebook).trim(),
          profile: CONFIG.profile,
          home: CONFIG.home,
        });
      }
      return record.id;
    }
    if (flags['create-if-missing']) {
      return await resolveNotebookByTitle(explicitNotebook);
    }
    throw new Error(`Notebook not found: ${explicitNotebook}`);
  }

  const state = readState();
  if (flags['no-state'] !== true && state.notebookId) return state.notebookId;
  if (CONFIG.defaultNotebookId) return CONFIG.defaultNotebookId;
  if (CONFIG.autoCreateDefaultNotebook) {
    const created = await run(CONFIG.bin, ['create', CONFIG.defaultNotebookTitle, '--json']);
    const parsed = parseJson(created);
    const id = parsed?.notebook?.id;
    if (id) {
      writeState({
        notebookId: id,
        notebookTitle: CONFIG.defaultNotebookTitle,
        profile: CONFIG.profile,
        home: CONFIG.home,
      });
      return id;
    }
  }
  throw new Error('No notebook selected. Pass --notebook or set NOTEBOOKLM_DEFAULT_NOTEBOOK_ID.');
}

async function resolveNotebookByTitle(title) {
  const record = await findNotebookRecord(title);
  if (record?.id) {
    const notebooks = await listNotebooks();
    const match = notebooks.find(item => item.id === record.id);
    writeState({
      notebookId: match?.id || record.id,
      notebookTitle: match?.title || title,
      profile: CONFIG.profile,
      home: CONFIG.home,
    });
    return record.id;
  }

  const created = await run(CONFIG.bin, ['create', title, '--json']);
  const createdParsed = parseJson(created);
  const id = createdParsed?.notebook?.id;
  if (!id) {
    throw new Error(`Failed to create notebook "${title}"`);
  }
  writeState({
    notebookId: id,
    notebookTitle: title,
    profile: CONFIG.profile,
    home: CONFIG.home,
  });
  return id;
}

async function cmdStatus() {
  const output = await run(CONFIG.bin, ['status', '--json']);
  console.log(output);
}

async function cmdLogin() {
  await runInteractive(CONFIG.bin, ['login'], { timeoutMs: 30 * 60 * 1000 });
}

async function cmdNotebooks() {
  const notebooks = await listNotebooks();
  console.log(JSON.stringify({ notebooks }, null, 2));
}

async function cmdCreate(flags, positionals) {
  const title = positionals.join(' ').trim();
  if (!title) throw new Error('create requires a title');
  const output = await run(CONFIG.bin, ['create', title, '--json']);
  const parsed = parseJson(output);
  const id = parsed?.notebook?.id;
  if (id) {
    writeState({
      notebookId: id,
      notebookTitle: parsed?.notebook?.title || title,
      profile: CONFIG.profile,
      home: CONFIG.home,
    });
  }
  console.log(output);
}

async function cmdAddSource(flags, positionals) {
  const content = positionals.join(' ').trim();
  if (!content) throw new Error('add-source requires content');
  const notebookId = await resolveNotebookId(flags);
  const args = ['source', 'add', content, '-n', notebookId, '--json'];
  if (flags.type) args.push('--type', flags.type);
  if (flags.title) args.push('--title', flags.title);
  if (flags['mime-type']) args.push('--mime-type', flags['mime-type']);
  const output = await run(CONFIG.bin, args);
  console.log(output);
}

async function cmdAsk(flags, positionals) {
  const question = positionals.join(' ').trim();
  if (!question) throw new Error('ask requires a question');
  const notebookId = await resolveNotebookId(flags);
  const args = ['ask', question, '-n', notebookId, '--json'];
  for (const sourceId of extractSourceList(flags)) {
    args.push('-s', sourceId);
  }
  if (flags['save-note']) args.push('--save-as-note');
  if (flags['note-title']) args.push('--note-title', flags['note-title']);
  const output = await run(CONFIG.bin, args);
  console.log(output);
}

async function cmdResearch(flags, positionals) {
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('research requires a query');
  const notebookId = await resolveNotebookId(flags);
  const args = [
    'source',
    'add-research',
    query,
    '-n',
    notebookId,
    '--mode',
    flags.mode || 'deep',
    '--from',
    flags.from || 'web',
    '--no-wait',
  ];
  await run(CONFIG.bin, args, { timeoutMs: CONFIG.researchTimeoutMs });
  const waitArgs = ['research', 'wait', '-n', notebookId, '--json'];
  if (flags['import-all']) waitArgs.push('--import-all');
  const output = await run(CONFIG.bin, waitArgs, { timeoutMs: CONFIG.researchTimeoutMs });
  console.log(output);
}

async function cmdSecondMind(flags, positionals) {
  const question = positionals.join(' ').trim();
  if (!question) throw new Error('second-mind requires a question');
  const notebookId = await resolveNotebookId(flags);

  const sources = extractSourceList(flags);
  for (const source of sources) {
    const output = await run(CONFIG.bin, ['source', 'add', source, '-n', notebookId, '--json']);
    process.stdout.write(`${output}\n`);
  }

  if (flags.research) {
    const researchArgs = [
      'source',
      'add-research',
      flags.research,
      '-n',
      notebookId,
      '--mode',
      flags.mode || 'deep',
      '--from',
      flags.from || 'web',
      '--no-wait',
    ];
    await run(CONFIG.bin, researchArgs, { timeoutMs: CONFIG.researchTimeoutMs });
    const waitArgs = ['research', 'wait', '-n', notebookId, '--json'];
    if (flags['import-all']) waitArgs.push('--import-all');
    const research = await run(CONFIG.bin, waitArgs, { timeoutMs: CONFIG.researchTimeoutMs });
    process.stdout.write(`${research}\n`);
  }

  const askArgs = ['ask', question, '-n', notebookId, '--json'];
  if (flags['save-note']) askArgs.push('--save-as-note');
  if (flags['note-title']) askArgs.push('--note-title', flags['note-title']);
  const answer = await run(CONFIG.bin, askArgs);
  console.log(answer);
}

async function cmdRegisterConnector() {
  const output = await run(process.execPath, ['scripts/register-notebooklm-connector.js']);
  console.log(output);
}

async function cmdBootstrap(flags) {
  let authenticated = false;
  try {
    const check = await run(CONFIG.bin, ['auth', 'check', '--json', '--test']);
    const parsedCheck = parseJson(check);
    authenticated = parsedCheck?.ok === true || parsedCheck?.authenticated === true;
  } catch {
    authenticated = false;
  }

  if (!authenticated) {
    console.error('NotebookLM auth is not ready. Opening login flow...');
    await runInteractive(CONFIG.bin, ['login'], { timeoutMs: 30 * 60 * 1000 });
  }

  const explicitNotebook = flags.notebook || flags['notebook-title'] || flags['notebook-id'] || null;
  const shouldRemember = flags.remember === true;
  if (explicitNotebook) {
    const resolved = await resolveNotebookId({
      ...flags,
      notebook: explicitNotebook,
    });

    const notebooks = await listNotebooks();
    const match = notebooks.find(item => item.id === resolved) || null;
    if (shouldRemember) {
      writeState({
        notebookId: resolved,
        notebookTitle: match?.title || String(explicitNotebook).trim(),
        profile: CONFIG.profile,
        home: CONFIG.home,
      });
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      notebookId: resolved,
      notebookTitle: match?.title || String(explicitNotebook).trim(),
      remembered: shouldRemember,
      stateFile: CONFIG.stateFile,
    }, null, 2));
    process.stdout.write('\n');
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    authenticated: true,
    notebookId: null,
    notebookTitle: null,
    remembered: false,
    stateFile: CONFIG.stateFile,
  }, null, 2));
  process.stdout.write('\n');
}

async function main() {
  const [, , command, ...argv] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }

  const { flags, positionals } = parseArgs(argv);

  switch (command) {
    case 'login':
      await cmdLogin();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'notebooks':
      await cmdNotebooks();
      break;
    case 'create':
      await cmdCreate(flags, positionals);
      break;
    case 'ask':
      await cmdAsk(flags, positionals);
      break;
    case 'add-source':
      await cmdAddSource(flags, positionals);
      break;
    case 'research':
      await cmdResearch(flags, positionals);
      break;
    case 'second-mind':
      await cmdSecondMind(flags, positionals);
      break;
    case 'register-connector':
      await cmdRegisterConnector();
      break;
    case 'bootstrap':
      await cmdBootstrap(flags);
      break;
    default:
      usage();
      process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
