#!/usr/bin/env node
/**
 * NotebookLM MCP Server
 *
 * Thin MCP wrapper around the upstream `notebooklm-py` CLI.
 * Exposes NotebookLM as a research "second mind" for any MCP client.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const CONFIG = {
  serverName: 'notebooklm-research',
  serverVersion: '0.1.0',
  notebooklmBin: process.env.NOTEBOOKLM_BIN || 'notebooklm',
  defaultNotebookId: process.env.NOTEBOOKLM_DEFAULT_NOTEBOOK_ID || null,
  defaultNotebookTitle: process.env.NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE || 'Second Mind',
  autoCreateDefaultNotebook: process.env.NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK === '1',
  timeoutMs: Number(process.env.NOTEBOOKLM_TIMEOUT_MS || 120000),
  cwd: process.cwd(),
};

function cleanArgs(args) {
  return args.filter(Boolean).map(value => String(value));
}

function spawnCli(args, { cwd = CONFIG.cwd, timeoutMs = CONFIG.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.notebooklmBin, cleanArgs(args), {
      cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`NotebookLM command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `NotebookLM exited with code ${code}`;
        reject(new Error(message));
        return;
      }

      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
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

async function runNotebookLm(args, options = {}) {
  const result = await spawnCli(args, options);
  const parsed = parseJson(result.stdout);
  return parsed ?? { text: result.stdout, stderr: result.stderr };
}

async function listNotebooks() {
  return runNotebookLm(['list', '--json']);
}

async function createNotebook(title) {
  return runNotebookLm(['create', title, '--json']);
}

async function resolveNotebookId({ notebookId = null, notebookTitle = null, createIfMissing = false } = {}) {
  if (notebookId) {
    return notebookId;
  }

  if (CONFIG.defaultNotebookId) {
    return CONFIG.defaultNotebookId;
  }

  const title = notebookTitle || CONFIG.defaultNotebookTitle;
  const notebooks = await listNotebooks();
  const entries = notebooks?.notebooks || [];
  const match = entries.find(item => item.title === title);
  if (match?.id) {
    return match.id;
  }

  if (!createIfMissing && !CONFIG.autoCreateDefaultNotebook) {
    throw new Error(
      `No notebook selected. Pass notebookId or set NOTEBOOKLM_DEFAULT_NOTEBOOK_ID. ` +
        `You can also set NOTEBOOKLM_AUTO_CREATE_DEFAULT_NOTEBOOK=1 to create "${title}" automatically.`
    );
  }

  const created = await createNotebook(title);
  const id = created?.notebook?.id;
  if (!id) {
    throw new Error(`Failed to create notebook "${title}"`);
  }
  return id;
}

async function addSourceToNotebook(notebookId, source) {
  const args = ['source', 'add', source.content, '-n', notebookId, '--json'];

  if (source.type) {
    args.push('--type', source.type);
  }
  if (source.title) {
    args.push('--title', source.title);
  }
  if (source.mimeType) {
    args.push('--mime-type', source.mimeType);
  }

  return runNotebookLm(args);
}

async function startAndWaitForResearch(notebookId, query, { mode = 'deep', from = 'web', importAll = true, timeoutMs } = {}) {
  const researchTimeoutMs = timeoutMs || Number(process.env.NOTEBOOKLM_RESEARCH_TIMEOUT_MS || 600000);
  await runNotebookLm([
    'source',
    'add-research',
    query,
    '-n',
    notebookId,
    '--mode',
    mode,
    '--from',
    from,
    '--no-wait',
  ], { timeoutMs: researchTimeoutMs });

  return runNotebookLm([
    'research',
    'wait',
    '-n',
    notebookId,
    '--json',
    ...(importAll ? ['--import-all'] : []),
  ], { timeoutMs: researchTimeoutMs });
}

function formatResult(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

const server = new Server(
  {
    name: CONFIG.serverName,
    version: CONFIG.serverVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notebooklm_status',
      description: 'Check NotebookLM auth, storage, and current notebook context.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'notebooklm_list_notebooks',
      description: 'List notebooks available in NotebookLM.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'notebooklm_create_notebook',
      description: 'Create a new NotebookLM notebook.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notebook title' },
        },
        required: ['title'],
      },
    },
    {
      name: 'notebooklm_add_source',
      description: 'Add a URL, file, YouTube link, or pasted text as a NotebookLM source.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Notebook ID. Defaults to NOTEBOOKLM_DEFAULT_NOTEBOOK_ID or a notebook matching NOTEBOOKLM_DEFAULT_NOTEBOOK_TITLE.' },
          notebookTitle: { type: 'string', description: 'Notebook title to resolve when notebookId is omitted.' },
          content: { type: 'string', description: 'URL, file path, or pasted text.' },
          type: { type: 'string', enum: ['url', 'text', 'file', 'youtube'], description: 'Optional explicit source type.' },
          title: { type: 'string', description: 'Optional title for text sources.' },
          mimeType: { type: 'string', description: 'Optional file MIME type.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'notebooklm_ask',
      description: 'Ask a NotebookLM notebook a question and return answer plus citations.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Notebook ID.' },
          notebookTitle: { type: 'string', description: 'Notebook title to resolve when notebookId is omitted.' },
          question: { type: 'string', description: 'Question to ask.' },
          sourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional source IDs to constrain the answer.',
          },
          conversationId: { type: 'string', description: 'Optional conversation ID to continue.' },
          saveAsNote: { type: 'boolean', description: 'Save the answer as a note in NotebookLM.' },
          noteTitle: { type: 'string', description: 'Title for the saved note.' },
        },
        required: ['question'],
      },
    },
    {
      name: 'notebooklm_research',
      description: 'Run NotebookLM research and optionally import all discovered sources.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Notebook ID.' },
          notebookTitle: { type: 'string', description: 'Notebook title to resolve when notebookId is omitted.' },
          query: { type: 'string', description: 'Research query.' },
          from: { type: 'string', enum: ['web', 'drive'], description: 'Research source.' },
          mode: { type: 'string', enum: ['fast', 'deep'], description: 'Research depth.' },
          importAll: { type: 'boolean', description: 'Import all discovered sources into the notebook.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'notebooklm_second_mind',
      description: 'High-level research workflow: add sources, optionally run research, and ask NotebookLM.',
      inputSchema: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Notebook ID.' },
          notebookTitle: { type: 'string', description: 'Notebook title to resolve when notebookId is omitted.' },
          question: { type: 'string', description: 'Question to ask the notebook.' },
          sources: {
            type: 'array',
            description: 'Optional sources to add before asking.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'URL, file path, or pasted text.' },
                type: { type: 'string', enum: ['url', 'text', 'file', 'youtube'] },
                title: { type: 'string' },
                mimeType: { type: 'string' },
              },
              required: ['content'],
            },
          },
          researchQuery: { type: 'string', description: 'Optional NotebookLM research query to run first.' },
          researchMode: { type: 'string', enum: ['fast', 'deep'], description: 'Research mode when researchQuery is set.' },
          researchFrom: { type: 'string', enum: ['web', 'drive'], description: 'Research source when researchQuery is set.' },
          importAll: { type: 'boolean', description: 'Import all research sources when researchQuery is set.' },
          saveAsNote: { type: 'boolean', description: 'Save the final answer as a note.' },
          noteTitle: { type: 'string', description: 'Note title when saveAsNote is enabled.' },
        },
        required: ['question'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === 'notebooklm_status') {
      const status = await runNotebookLm(['status', '--json']);
      return { content: [{ type: 'text', text: formatResult(status) }] };
    }

    if (name === 'notebooklm_list_notebooks') {
      const notebooks = await listNotebooks();
      return { content: [{ type: 'text', text: formatResult(notebooks) }] };
    }

    if (name === 'notebooklm_create_notebook') {
      const validated = z.object({ title: z.string().min(1) }).parse(args);
      const notebook = await createNotebook(validated.title);
      return { content: [{ type: 'text', text: formatResult(notebook) }] };
    }

    if (name === 'notebooklm_add_source') {
      const validated = z.object({
        notebookId: z.string().optional(),
        notebookTitle: z.string().optional(),
        content: z.string().min(1),
        type: z.enum(['url', 'text', 'file', 'youtube']).optional(),
        title: z.string().optional(),
        mimeType: z.string().optional(),
      }).parse(args);

      const notebookId = await resolveNotebookId({
        notebookId: validated.notebookId,
        notebookTitle: validated.notebookTitle,
      });
      const result = await addSourceToNotebook(notebookId, validated);
      return { content: [{ type: 'text', text: formatResult({ notebookId, ...result }) }] };
    }

    if (name === 'notebooklm_ask') {
      const validated = z.object({
        notebookId: z.string().optional(),
        notebookTitle: z.string().optional(),
        question: z.string().min(1),
        sourceIds: z.array(z.string()).optional(),
        conversationId: z.string().optional(),
        saveAsNote: z.boolean().optional(),
        noteTitle: z.string().optional(),
      }).parse(args);

      const notebookId = await resolveNotebookId({
        notebookId: validated.notebookId,
        notebookTitle: validated.notebookTitle,
      });

      const cliArgs = ['ask', validated.question, '-n', notebookId, '--json'];
      for (const sourceId of validated.sourceIds || []) {
        cliArgs.push('-s', sourceId);
      }
      if (validated.conversationId) {
        cliArgs.push('--conversation-id', validated.conversationId);
      }
      if (validated.saveAsNote) {
        cliArgs.push('--save-as-note');
      }
      if (validated.noteTitle) {
        cliArgs.push('--note-title', validated.noteTitle);
      }

      const result = await runNotebookLm(cliArgs);
      return { content: [{ type: 'text', text: formatResult({ notebookId, ...result }) }] };
    }

    if (name === 'notebooklm_research') {
      const validated = z.object({
        notebookId: z.string().optional(),
        notebookTitle: z.string().optional(),
        query: z.string().min(1),
        from: z.enum(['web', 'drive']).optional(),
        mode: z.enum(['fast', 'deep']).optional(),
        importAll: z.boolean().optional(),
      }).parse(args);

      const notebookId = await resolveNotebookId({
        notebookId: validated.notebookId,
        notebookTitle: validated.notebookTitle,
      });

      const result = await startAndWaitForResearch(notebookId, validated.query, {
        from: validated.from || 'web',
        mode: validated.mode || 'deep',
        importAll: validated.importAll !== false,
      });
      return { content: [{ type: 'text', text: formatResult({ notebookId, ...result }) }] };
    }

    if (name === 'notebooklm_second_mind') {
      const validated = z.object({
        notebookId: z.string().optional(),
        notebookTitle: z.string().optional(),
        question: z.string().min(1),
        sources: z.array(z.object({
          content: z.string().min(1),
          type: z.enum(['url', 'text', 'file', 'youtube']).optional(),
          title: z.string().optional(),
          mimeType: z.string().optional(),
        })).optional(),
        researchQuery: z.string().optional(),
        researchMode: z.enum(['fast', 'deep']).optional(),
        researchFrom: z.enum(['web', 'drive']).optional(),
        importAll: z.boolean().optional(),
        saveAsNote: z.boolean().optional(),
        noteTitle: z.string().optional(),
      }).parse(args);

      const notebookId = await resolveNotebookId({
        notebookId: validated.notebookId,
        notebookTitle: validated.notebookTitle,
        createIfMissing: true,
      });

      const addedSources = [];
      for (const source of validated.sources || []) {
        const result = await addSourceToNotebook(notebookId, source);
        addedSources.push(result);
      }

      let research = null;
      if (validated.researchQuery) {
        research = await startAndWaitForResearch(notebookId, validated.researchQuery, {
          from: validated.researchFrom || 'web',
          mode: validated.researchMode || 'deep',
          importAll: validated.importAll !== false,
        });
      }

      const askArgs = ['ask', validated.question, '-n', notebookId, '--json'];
      if (validated.saveAsNote) {
        askArgs.push('--save-as-note');
      }
      if (validated.noteTitle) {
        askArgs.push('--note-title', validated.noteTitle);
      }

      const answer = await runNotebookLm(askArgs);
      return {
        content: [{
          type: 'text',
          text: formatResult({
            notebookId,
            sourcesAdded: addedSources,
            research,
            answer,
          }),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: error.message }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  process.stderr.write('NotebookLM MCP server running on stdio\n');
});
