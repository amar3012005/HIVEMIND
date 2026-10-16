const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const profileStore = require('./browser-profiles');
const { AGENT_NAME, PROFILE_ID, ensurePrivateDir, normalizeAgentName, readProfiles,
  createAgentProfile, ensureDefaultProfile, getAgentProfile, profileIsActive, removeAgentProfile } = profileStore;
const APPROVAL_ACTIONS = new Set(['use', 'click', 'fill', 'press', 'check']);
const activeInstalls = new Map();

function browserPaths(userDataPath) {
  const approvalSocketDir = path.join(os.homedir(), 'Library', 'Caches', 'SINGULANCE', 'AgentBrowser');
  return { ...profileStore.browserPaths(userDataPath), approvalSocketDir,
    approvalSocket: path.join(approvalSocketDir, `${crypto.createHash('sha256').update(userDataPath).digest('hex').slice(0, 16)}.sock`) };
}
function selectBrowserRuntime(userDataPath, resourcesPath = process.resourcesPath) {
  const bundled = resourcesPath && path.join(resourcesPath, 'AgentBrowserRuntime', process.arch);
  const candidate = bundled && fs.existsSync(bundled) ? bundled : browserPaths(userDataPath).browsers;
  // Playwright resolves and caches this path at module initialization: set it
  // before requiring, not after calling chromium.executablePath().
  process.env.PLAYWRIGHT_BROWSERS_PATH = candidate;
  const { chromium } = require('playwright');
  return fs.existsSync(chromium.executablePath()) ? candidate : null;
}
function isRuntimeInstalled(userDataPath) {
  try { return Boolean(selectBrowserRuntime(userDataPath)); } catch { return false; }
}
function getRuntimeExecutable(userDataPath) {
  const runtime = selectBrowserRuntime(userDataPath);
  if (!runtime) throw new Error('Managed Chromium is missing');
  process.env.PLAYWRIGHT_BROWSERS_PATH = runtime;
  return require('playwright').chromium.executablePath();
}
function playwrightCliPath() {
  return path.join(path.dirname(require.resolve('playwright')), 'cli.js');
}
function installBrowserRuntime({ userDataPath, appPath, electronExecutable = process.execPath, spawnProcess = spawn, onOutput = () => {} }) {
  const paths = browserPaths(userDataPath);
  const existing = activeInstalls.get(paths.root);
  if (existing) return existing;
  if (isRuntimeInstalled(userDataPath)) return Promise.resolve({ installed: true, alreadyInstalled: true });
  ensurePrivateDir(paths.root);
  ensurePrivateDir(paths.browsers);
  const cli = playwrightCliPath();
  if (!fs.existsSync(cli)) return Promise.reject(new Error('Playwright browser installer is missing from this SINGULANCE build'));
  const promise = new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(electronExecutable, [cli, 'install', '--no-shell', 'chromium'], {
        cwd: paths.root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' },
      });
    } catch (error) {
      reject(new Error(`Could not start the browser installer: ${error.message}`));
      return;
    }
    let lastOutput = '';
    const collect = (chunk) => {
      lastOutput = `${lastOutput}${chunk.toString('utf8')}`.slice(-4000);
      for (const line of chunk.toString('utf8').split(/[\r\n]+/).filter(Boolean)) onOutput(line.slice(0, 300));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => reject(new Error(`Browser installer failed to start: ${error.message}`)));
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Browser installation failed (exit ${code === null ? 'unknown' : code}). ${lastOutput.trim().slice(-500)}`));
        return;
      }
      try {
        const executablePath = getRuntimeExecutable(userDataPath);
        if (!fs.existsSync(executablePath)) throw new Error('Chromium was not found after installation');
        resolve({ installed: true, alreadyInstalled: false, executablePath });
      } catch (error) { reject(error); }
    });
  }).finally(() => activeInstalls.delete(paths.root));
  activeInstalls.set(paths.root, promise);
  return promise;
}
function buildMcpConfig({ userDataPath, appExecutable, appPath, profileId }) {
  const profile = getAgentProfile({ userDataPath, profileId });
  const paths = browserPaths(userDataPath);
  const script = path.join(appPath, 'src', 'agent-browser-mcp.mjs');
  return {
    mcpServers: {
      [`singulance-agent-browser-${profile.id}`]: {
        command: appExecutable,
        args: [script, '--home', paths.root, '--profile-id', profile.id, '--approval-socket', paths.approvalSocket],
        env: { ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: selectBrowserRuntime(userDataPath) || paths.browsers },
      },
    },
  };
}
function safeApprovalText(value, max = 120) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function startApprovalServer({ userDataPath, dialog, getParentWindow = () => null, log = console, createServer = net.createServer, socketPath = null, authorizeAction = async () => true }) {
  const paths = browserPaths(userDataPath);
  const approvalPath = socketPath || paths.approvalSocket;
  ensurePrivateDir(paths.root);
  ensurePrivateDir(path.dirname(approvalPath));
  try { if (fs.existsSync(approvalPath)) fs.unlinkSync(approvalPath); } catch (error) { log.error('Could not clear stale agent-browser approval socket', error); }
  let pending = Promise.resolve();
  let queued = 0;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > 4096) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); } catch { socket.end(JSON.stringify({ approved: false, reason: 'invalid request' }) + '\n'); return; }
      if (queued >= 4) { socket.end(JSON.stringify({ approved: false, reason: 'approval queue is full' }) + '\n'); return; }
      queued += 1;
      pending = pending.then(async () => {
        try {
          if (!request || !PROFILE_ID.test(request.profileId || '') || !APPROVAL_ACTIONS.has(request.action)) {
            socket.end(JSON.stringify({ approved: false, reason: 'invalid approval request' }) + '\n'); return;
          }
          const profile = getAgentProfile({ userDataPath, profileId: request.profileId });
          if (request.action === 'check') {
            socket.end(JSON.stringify({ approved: await authorizeAction({ profileId: profile.id, action: 'check' }) }) + '\n');
            return;
          }
          let origin;
          if (request.action !== 'use') {
            try {
              const url = new URL(request.origin);
              if (!['http:', 'https:'].includes(url.protocol) || url.origin !== request.origin) throw new Error('bad origin');
              origin = url.origin;
            } catch { socket.end(JSON.stringify({ approved: false, reason: 'invalid page origin' }) + '\n'); return; }
          }
          const target = safeApprovalText(request.target);
          const detail = request.action === 'use'
            ? 'A local agent wants to open the separate SINGULANCE Chromium profile. It will not use your personal Chrome profile. Allowing access here does not approve later clicks, text entry or key presses.'
            : [
              `Agent: ${profile.name}`,
              `Page: ${origin}`,
              `Requested action: ${request.action}`,
              target ? `Target: ${target}` : '',
              '',
              'Only approve if you intended this action. Page content and agent requests are untrusted.',
            ].filter(Boolean).join('\n');
          const options = request.action === 'use' ? {
            type: 'question', title: 'Allow agent browser access?',
            message: 'A local agent wants to use SINGULANCE Browser.', detail,
            buttons: ['Allow browser', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
          } : {
            type: 'warning', title: 'Approve agent browser action?',
            message: `${profile.name} wants to interact with a webpage.`, detail,
            buttons: ['Approve once', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
          };
          let answer;
          const parent = getParentWindow();
          if (parent && !parent.isDestroyed()) answer = await dialog.showMessageBox(parent, options);
          else answer = await dialog.showMessageBox(options);
          const authorized = answer.response === 0 && await authorizeAction({ profileId: profile.id, action: request.action });
          socket.end(JSON.stringify({ approved: authorized }) + '\n');
        } catch (error) {
          log.error('Agent browser approval failed', error);
          if (!socket.destroyed) socket.end(JSON.stringify({ approved: false, reason: 'approval failed' }) + '\n');
        }
      }).finally(() => { queued = Math.max(0, queued - 1); });
    });
    socket.setTimeout(90_000, () => socket.destroy());
  });
  server.on('error', (error) => log.error('Agent browser approval socket error', error));
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(approvalPath, () => {
      try { fs.chmodSync(approvalPath, 0o600); } catch {}
      resolve(approvalPath);
    });
  });
  return {
    ready,
    socketPath: approvalPath,
    close() {
      try { server.close(); } catch {}
      try { if (fs.existsSync(approvalPath)) fs.unlinkSync(approvalPath); } catch {}
    },
  };
}
module.exports = {
  AGENT_NAME, browserPaths, normalizeAgentName, readProfiles, createAgentProfile, ensureDefaultProfile,
  getAgentProfile, removeAgentProfile, profileIsActive, isRuntimeInstalled, getRuntimeExecutable,
  installBrowserRuntime, buildMcpConfig, startApprovalServer,
};
