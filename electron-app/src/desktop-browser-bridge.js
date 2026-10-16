const path = require('node:path');
const { readProfiles, createAgentProfile, getAgentProfile } = require('./browser-profiles');

const DOT_ORIGIN = 'https://dots.singulancelabs.com';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['browser.openUrl', 'browser.readPage', 'browser.clickText', 'browser.typeText', 'browser.screenshot', 'browser.doAction']);

function createDesktopBrowserBridge({ userDataPath, appPath, appExecutable, fetchSession, approvalReady, createLocalExecutor, log = console }) {
  const connections = new Map();
  const profiles = new Map();
  const remoteProfiles = new Set();
  const currentBindings = new Map();
  let closed = false;
  async function api(operation, body, connection, signal) {
    const response = await fetchSession(`${DOT_ORIGIN}/api/desktop-browser/${operation}`, {
      method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: DOT_ORIGIN,
        ...(connection ? { 'x-singulance-browser-key': connection.credential } : {}) },
      body: JSON.stringify(body), signal: signal || AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Desktop browser authorization or connection is unavailable');
    return response.json();
  }
  async function clientFor(profile) {
    if (!createLocalExecutor) {
      const { isRuntimeInstalled } = require('./managed-agent-browser');
      if (!isRuntimeInstalled(userDataPath)) throw new Error('Install Agent Browser from the SINGULANCE menu before using this Mac browser');
      await approvalReady();
    }
    let pending = profiles.get(profile.id);
    if (!pending) {
      pending = (async () => {
        if (createLocalExecutor) {
          const executor = await createLocalExecutor(profile);
          return { execute: executor.execute, close: executor.close, tail: Promise.resolve(), active: null };
        }
        const { buildMcpConfig } = require('./managed-agent-browser');
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const config = buildMcpConfig({ userDataPath, appExecutable, appPath, profileId: profile.id });
        const entry = Object.values(config.mcpServers)[0];
        const transport = new StdioClientTransport({ ...entry, cwd: path.dirname(profile.profilePath), stderr: 'ignore' });
        const client = new Client({ name: 'singulance-owned-desktop-browser', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        return { execute: (operation, signal) => client.callTool({ name: 'browser_execute_owned', arguments: { operation } }, undefined, { timeout: 245000, signal }),
          close: () => client.close(), tail: Promise.resolve(), active: null };
      })();
      profiles.set(profile.id, pending);
      pending.catch(() => profiles.delete(profile.id));
    }
    return pending;
  }
  async function execute(connection, command) {
    if (!command || !UUID.test(command.id || '') || command.connectionId !== connection.connectionId || command.profileId !== connection.profile.id ||
        command.dotId !== connection.dotId || typeof command.conversationId !== 'string' || !/^[1-9][0-9]*$/.test(command.generation || '') ||
        !OPERATIONS.has(command.operation?.kind)) throw new Error('Rejected desktop browser command scope');
    const owned = await clientFor(connection.profile);
    const run = owned.tail.then(async () => {
      await api('check', { connectionId: connection.connectionId, operationId: command.id }, connection);
      const operationController = new AbortController();
      const signal = AbortSignal.any([connection.controller.signal, operationController.signal]);
      let checking = false;
      const monitor = setInterval(() => {
        if (checking || signal.aborted) return;
        checking = true;
        api('check', { connectionId: connection.connectionId, operationId: command.id }, connection,
          AbortSignal.any([signal, AbortSignal.timeout(3000)]))
          .catch(() => operationController.abort(new Error('Browser execution authority revoked')))
          .finally(() => { checking = false; });
      }, 500);
      monitor.unref?.();
      owned.active = { connection, command, signal };
      try {
        signal.throwIfAborted();
        const result = await owned.execute(command.operation, signal, connection.connectionId);
        const image = result.content?.find(part => part.type === 'image');
        const text = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
        if (result._meta?.desktopOutcome === 'unknown') return { unknown: true };
        if (result.isError) return { error: text.slice(0, 600) || 'Local browser operation failed' };
        if (image) {
          if (image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 11200000) throw new Error('Invalid local browser screenshot');
          return { base64: image.data };
        }
        return { text: text.slice(0, 24000) };
      } catch { return { unknown: true }; }
      finally { clearInterval(monitor); owned.active = null; }
    });
    owned.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  async function serve(connection) {
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || connection.controller.signal.aborted) return;
      heartbeatBusy = true;
      api('heartbeat', { connectionId: connection.connectionId }, connection, connection.controller.signal)
        .catch(() => connection.controller.abort()).finally(() => { heartbeatBusy = false; });
    }, 30000);
    heartbeat.unref?.();
    try {
      while (!closed && !connection.controller.signal.aborted) {
        const packet = await api('poll', { connectionId: connection.connectionId }, connection, connection.controller.signal);
        if (!packet.command) continue;
        let result;
        try { result = await execute(connection, packet.command); }
        catch (error) { result = { error: error instanceof Error ? error.message.slice(0, 600) : 'Local browser operation failed' }; }
        const command = packet.command;
        const response = { id: command.id, connectionId: connection.connectionId, profileId: connection.profile.id,
          dotId: connection.dotId, conversationId: command.conversationId, generation: command.generation, result };
        // Submit a receipt again if acknowledgement is lost; never execute its browser action again.
        try { await api('result', { connectionId: connection.connectionId, response }, connection, connection.controller.signal); }
        catch { await api('result', { connectionId: connection.connectionId, response }, connection, connection.controller.signal); }
      }
    } catch {
      connection.controller.abort();
      log.warn('Desktop browser connection ended; server fallback is disabled');
    } finally { clearInterval(heartbeat); connections.delete(connection.connectionId); }
  }
  async function pair(request) {
    if (!TOKEN.test(request.ticket || '')) throw new Error('Invalid desktop browser pairing');
    const identity = await api('inspect', { ticket: request.ticket });
    if (identity.dotId !== request.dotId || identity.employeeId !== request.employeeId || !/^[a-f0-9]{64}$/.test(identity.scopeKey || '')) throw new Error('Desktop browser employee binding mismatch');
    const name = `Dot ${identity.scopeKey.slice(0, 40)}`;
    const existing = readProfiles(userDataPath).find(profile => profile.name === name);
    const profile = existing ? getAgentProfile({ userDataPath, profileId: existing.id }) : createAgentProfile({ userDataPath, name });
    const connected = await api('connect', { ticket: request.ticket, profileId: profile.id });
    if (!UUID.test(connected.connectionId || '') || !TOKEN.test(connected.credential || '') || connected.dotId !== request.dotId || connected.profileId !== profile.id) throw new Error('Invalid desktop browser connection');
    const connection = { ...connected, employeeId: request.employeeId, profile, controller: new AbortController() };
    remoteProfiles.add(profile.id);
    connections.set(connection.connectionId, connection);
    currentBindings.set(JSON.stringify([connection.dotId, connection.employeeId]), connection.connectionId);
    void serve(connection);
    return { ok: true, desktop: true };
  }
  return {
    async handle(request, expectedEmployeeId) {
      if (closed || !request || request.version !== 1 || !UUID.test(request.nonce || '') || request.employeeId !== expectedEmployeeId ||
          typeof request.dotId !== 'string' || !request.dotId || request.dotId.length > 200) throw new Error('Invalid owned desktop browser request');
      if (request.action === 'detect') return { desktop: true };
      if (request.action === 'pair') return pair(request);
      if (request.action === 'proof') {
        const connection = connections.get(currentBindings.get(JSON.stringify([request.dotId, expectedEmployeeId])));
        if (!connection || connection.controller.signal.aborted || typeof request.admissionRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(request.admissionRequestId)) throw new Error('Desktop browser is not paired or is disconnected');
        const result = await api('proof', { connectionId: connection.connectionId, requestId: request.admissionRequestId }, connection);
        if (!TOKEN.test(result.proof || '')) throw new Error('Invalid desktop browser admission');
        return { proof: result.proof, desktop: true };
      }
      throw new Error('Desktop browser request is not supported');
    },
    async reviewUnknown(employeeId, confirm) {
      const connection = [...connections.values()].find(candidate => candidate.employeeId === employeeId && !candidate.controller.signal.aborted &&
        currentBindings.get(JSON.stringify([candidate.dotId, employeeId])) === candidate.connectionId);
      if (!connection) throw new Error('Open and reconnect this employee browser before reviewing its paused actions');
      const packet = await api('uncertain', { connectionId: connection.connectionId }, connection);
      if (!Array.isArray(packet.operations) || packet.operations.length > 16 || packet.operations.some(id => !UUID.test(id))) throw new Error('Invalid browser reconciliation records');
      if (!packet.operations.length || !await confirm(packet.operations.length)) return;
      for (const operationId of packet.operations) {
        await api('reconcile', { connectionId: connection.connectionId, operationId }, connection);
      }
    },
    async authorizeProfile(profileId) {
      if (!remoteProfiles.has(profileId)) return true;
      const owned = await profiles.get(profileId);
      const active = owned?.active;
      if (closed || !active || active.signal.aborted) return false;
      try {
        await api('check', { connectionId: active.connection.connectionId, operationId: active.command.id }, active.connection,
          AbortSignal.any([active.signal, AbortSignal.timeout(3000)]));
        return true;
      } catch { return false; }
    },
    async close() {
      closed = true;
      const active = [...connections.values()];
      for (const connection of active) connection.controller.abort();
      await Promise.allSettled(active.map(connection => api('revoke', { connectionId: connection.connectionId }, connection, AbortSignal.timeout(2000))));
      await Promise.allSettled([...profiles.values()].map(async pending => { const owned = await pending; await owned.close(); }));
      connections.clear(); profiles.clear(); currentBindings.clear();
    },
  };
}
module.exports = { createDesktopBrowserBridge };
