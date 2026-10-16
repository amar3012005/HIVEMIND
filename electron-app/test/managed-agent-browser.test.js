const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const {
  browserPaths, createAgentProfile, ensureDefaultProfile, getAgentProfile, removeAgentProfile,
  profileIsActive, buildMcpConfig, installBrowserRuntime, startApprovalServer,
} = require('../src/managed-agent-browser');

function tempHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-agent-browser-'));
  return { base, userData: path.join(base, 'SINGULANCE User Data'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function socketRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline >= 0) {
        try { resolve(JSON.parse(data.slice(0, newline))); } catch (error) { reject(error); }
        socket.destroy();
      }
    });
  });
}

test('profiles use separate private directories and enforce unique names', (t) => {
  const home = tempHome(); t.after(home.cleanup);
  const first = createAgentProfile({ userDataPath: home.userData, name: 'Mac A - Codex - Marketing' });
  assert.equal(fs.statSync(first.profilePath).mode & 0o777, 0o700);
  assert.equal(fs.statSync(browserPaths(home.userData).registry).mode & 0o777, 0o600);
  assert.throws(() => createAgentProfile({ userDataPath: home.userData, name: 'mac a - codex - marketing' }), /unique name/i);
  assert.equal(getAgentProfile({ userDataPath: home.userData, profileId: first.id }).profilePath, first.profilePath);
  assert.throws(() => getAgentProfile({ userDataPath: home.userData, profileId: '../personal-chrome' }), /Unknown agent browser profile/);
});

test('the default local browser profile is created once without user setup', (t) => {
  const home = tempHome(); t.after(home.cleanup);
  const first = ensureDefaultProfile(home.userData);
  const second = ensureDefaultProfile(home.userData);
  assert.equal(first.id, second.id);
  assert.equal(fs.statSync(first.profilePath).mode & 0o777, 0o700);
});

test('active or dangling Chromium lock files prevent profile deletion', (t) => {
  const home = tempHome(); t.after(home.cleanup);
  const profile = createAgentProfile({ userDataPath: home.userData, name: 'Mac B - Prime Agent - Ops' });
  fs.symlinkSync('missing-target', path.join(profile.profilePath, 'SingletonLock'));
  assert.equal(profileIsActive(profile.profilePath), true);
  assert.throws(() => removeAgentProfile({ userDataPath: home.userData, profileId: profile.id }), /Close this agent browser/);
  fs.unlinkSync(path.join(profile.profilePath, 'SingletonLock'));
  assert.equal(profileIsActive(profile.profilePath), false);
  removeAgentProfile({ userDataPath: home.userData, profileId: profile.id });
  assert.equal(fs.existsSync(profile.profilePath), false);
});

test('MCP config launches through the SINGULANCE Electron Node runtime and pins one profile', (t) => {
  const home = tempHome(); t.after(home.cleanup);
  const profile = createAgentProfile({ userDataPath: home.userData, name: 'Mac A - Codex - Ops' });
  const config = buildMcpConfig({ userDataPath: home.userData, appExecutable: '/Applications/SINGULANCE.app/Contents/MacOS/SINGULANCE',
    appPath: '/Applications/SINGULANCE.app/Contents/Resources/app.asar', profileId: profile.id });
  const entry = config.mcpServers[`singulance-agent-browser-${profile.id}`];
  assert.equal(entry.command, '/Applications/SINGULANCE.app/Contents/MacOS/SINGULANCE');
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(entry.args[3], '--profile-id');
  assert.equal(entry.args[4], profile.id);
  assert.equal(entry.args[0], '/Applications/SINGULANCE.app/Contents/Resources/app.asar/src/agent-browser-mcp.mjs');
  assert.ok(entry.args.includes(browserPaths(home.userData).approvalSocket));
});

test('browser installation runs the Playwright installer through Electron-as-Node in the app-owned cache', async (t) => {
  const home = tempHome(); t.after(home.cleanup);
  let spawnOptions; let spawnedCommand; let spawnedArgs;
  const fakeChild = new EventEmitter();
  queueMicrotask(() => fakeChild.emit('exit', 17));
  await assert.rejects(installBrowserRuntime({ userDataPath: home.userData, appPath: '/app.asar', electronExecutable: '/app/SINGULANCE',
    spawnProcess: (command, args, options) => { spawnedCommand = command; spawnedArgs = args; spawnOptions = options; return fakeChild; } }), /exit 17/);
  assert.equal(spawnedCommand, '/app/SINGULANCE');
  assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawnOptions.env.PLAYWRIGHT_BROWSERS_PATH, browserPaths(home.userData).browsers);
  assert.equal(spawnedArgs[1], 'install');
  assert.equal(spawnedArgs[2], '--no-shell');
  assert.equal(spawnedArgs[3], 'chromium');
});

test('approval socket asks SINGULANCE and returns deny/approve decisions without exposing a field value', async (t) => {
  const home = tempHome(); t.after(home.cleanup);
  const profile = createAgentProfile({ userDataPath: home.userData, name: 'Mac A - Prime Agent - Outreach' });
  const prompts = [];
  let answer = 0;
  const testSocket = path.join(os.tmpdir(), `singulance-test-${process.pid}-${Date.now()}.sock`);
  const approval = startApprovalServer({ userDataPath: home.userData, socketPath: testSocket,
    dialog: { showMessageBox: async (options) => { prompts.push(options); return { response: answer }; } }, getParentWindow: () => null, log: { error() {} } });
  t.after(() => approval.close());
  await approval.ready;
  answer = 1;
  const denied = await socketRequest(approval.socketPath, { profileId: profile.id, action: 'use', origin: '', target: '' });
  assert.equal(denied.approved, false);
  assert.match(prompts[0].message, /local agent/i);
  answer = 0;
  const allowed = await socketRequest(approval.socketPath, { profileId: profile.id, action: 'use', origin: '', target: '' });
  assert.equal(allowed.approved, true);
  const first = await socketRequest(approval.socketPath, { profileId: profile.id, action: 'fill', origin: 'https://example.com', target: 'Email address' });
  assert.equal(first.approved, true);
  assert.match(prompts[2].detail, /Mac A - Prime Agent - Outreach/);
  assert.match(prompts[2].detail, /https:\/\/example\.com/);
  assert.doesNotMatch(prompts[2].detail, /password|secret-value/i);
  answer = 1;
  const second = await socketRequest(approval.socketPath, { profileId: profile.id, action: 'click', origin: 'https://example.com', target: 'Submit\nmalicious text' });
  assert.equal(second.approved, false);
  assert.doesNotMatch(prompts[3].detail, /\nmalicious/);
});
