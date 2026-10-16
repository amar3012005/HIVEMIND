const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f-]{36}$/i;
const TTL = 7 * 86400000, AUTH_TTL = 86400000;

// Only presentation data enters this store. No credentials, executable HTML,
// native event journals or queued actions are persisted or replayed.
class OfflineHistoryStore {
  constructor({ directory, safeStorage, now = Date.now }) {
    this.directory = directory; this.safeStorage = safeStorage; this.now = now;
    this.active = null; this.key = null; this.queue = Promise.resolve(); this.epoch = 0;
  }
  async init() {
    if (!await this.safeStorage.isAsyncEncryptionAvailable()) return false;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      const saved = await fs.readFile(path.join(this.directory, 'key.enc'));
      const { result, shouldReEncrypt } = await this.safeStorage.decryptStringAsync(saved);
      if (shouldReEncrypt) await this.atomic('key.enc', await this.safeStorage.encryptStringAsync(result));
      this.key = Buffer.from(result, 'base64');
      if (this.key.length !== 32) throw Error('Invalid offline key');
    } catch (error) {
      if (error.code !== 'ENOENT') return false; // Locked or changed Keychain never falls back to plaintext.
      this.key = crypto.randomBytes(32);
      await this.atomic('key.enc', await this.safeStorage.encryptStringAsync(this.key.toString('base64')));
    }
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.enc$/.test(name)) continue;
      if (this.now() - (await fs.stat(path.join(this.directory, name))).mtimeMs > TTL) await fs.rm(path.join(this.directory, name), { force: true });
    }
    try { this.active = await this.readEncrypted('active.enc', 'active'); } catch {}
    if (!this.active || this.now() - this.active.verifiedAt > AUTH_TTL) this.active = null;
    return true;
  }
  async atomic(file, bytes) {
    const destination = path.join(this.directory, file), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, destination); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  encode(value, aad) {
    if (!this.key) throw Error('Offline encryption unavailable');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`singulance-history-v1:${aad}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
  }
  async readEncrypted(file, aad) {
    const bytes = await fs.readFile(path.join(this.directory, file));
    if (bytes.length < 30 || bytes[0] !== 1 || !this.key) throw Error('Invalid encrypted history');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, 13));
    decipher.setAAD(Buffer.from(`singulance-history-v1:${aad}`)); decipher.setAuthTag(bytes.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
  }
  serial(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  scopeFor(identity) {
    if (!uuid.test(identity?.organizationId || '') || !uuid.test(identity?.userId || '')) throw Error('Authenticated account required');
    return hash(JSON.stringify([identity.organizationId, identity.userId]));
  }
  activate(identity) {
    const scope = this.scopeFor(identity); const epoch = ++this.epoch;
    this.active = { scope, company: String(identity.company || 'Your company').slice(0, 160), verifiedAt: this.now() };
    const active = this.active;
    return this.serial(async () => { if (epoch === this.epoch && this.key) await this.atomic('active.enc', this.encode(active, 'active')); });
  }
  lock({ purge = false } = {}) {
    const scope = this.active?.scope; ++this.epoch; this.active = null;
    return this.serial(async () => {
      await fs.rm(path.join(this.directory, 'active.enc'), { force: true });
      if (purge && scope) for (const name of await fs.readdir(this.directory)) if (name.startsWith(`${scope}-`)) await fs.rm(path.join(this.directory, name), { force: true });
    });
  }
  available() { return this.key && this.active && this.now() - this.active.verifiedAt <= AUTH_TTL; }
  save(snapshot) {
    const active = this.active, epoch = this.epoch;
    if (!this.available()) return Promise.resolve(false);
    const value = normalizeSnapshot(snapshot), id = hash(value.route);
    return this.serial(async () => {
      if (epoch !== this.epoch || !this.available()) return false;
      const file = `${active.scope}-${id}.enc`;
      await this.atomic(file, this.encode({ ...value, scope: active.scope, id, savedAt: this.now() }, `${active.scope}:${id}`));
      const files = await fs.readdir(this.directory), rows = [];
      for (const name of files.filter(name => name.startsWith(active.scope + '-') && /^[a-f0-9-]+\.enc$/.test(name))) {
        const info = await fs.stat(path.join(this.directory, name)); rows.push({ name, ...info });
      }
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs); let bytes = 0;
      for (let i = 0; i < rows.length; i++) { bytes += rows[i].size; if (i >= 40 || bytes > 20 * 1024 * 1024 || this.now() - rows[i].mtimeMs > TTL) await fs.rm(path.join(this.directory, rows[i].name), { force: true }); }
      return true;
    });
  }
  async findRoute(route) {
    if (!this.available()) return null;
    const url = new URL(route), epoch = this.epoch;
    if (url.origin !== 'https://runtime-runner.singulancelabs.com') return null;
    const exact = url.origin + url.pathname + (url.searchParams.has('c') ? '?c=' + url.searchParams.get('c') : '');
    const listing = await this.list();
    for (const summary of listing.rooms) {
      const row = await this.read(summary.id).catch(() => null);
      if (epoch !== this.epoch) return null;
      if (row && (row.route === exact || (!url.searchParams.has('c') && new URL(row.route).pathname === url.pathname))) return row;
    }
    return null;
  }
  async list() {
    if (!this.available()) return { company: null, rooms: [] };
    const active = this.active, epoch = this.epoch, rooms = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.startsWith(active.scope + '-')) continue;
      const id = name.slice(65, -4); if (!/^[a-f0-9]{64}$/.test(id)) continue;
      try { const row = await this.read(id); if (row) rooms.push({ id, title: row.title, provider: row.provider, savedAt: row.savedAt, count: row.messages.length }); } catch { /* Tampered or incompatible data is never shown. */ }
    }
    return epoch === this.epoch ? { company: active.company, rooms: rooms.sort((a, b) => b.savedAt - a.savedAt) } : { company: null, rooms: [] };
  }
  async read(id) {
    if (!this.available() || !/^[a-f0-9]{64}$/.test(id)) return null;
    const active = this.active, epoch = this.epoch;
    const row = await this.readEncrypted(`${active.scope}-${id}.enc`, `${active.scope}:${id}`);
    if (epoch !== this.epoch || row.scope !== active.scope || row.id !== id || this.now() - row.savedAt > TTL) return null;
    return row;
  }
}
function normalizeSnapshot(input) {
  const url = new URL(input?.route);
  if (url.origin !== 'https://runtime-runner.singulancelabs.com' || !/^\/hivemind\/app\/employee\/(?:harness\/session\/session-[a-z0-9]+|dots\/employee\/[0-9a-f-]{36})$/.test(url.pathname)) throw Error('Invalid cached conversation');
  const conversation = url.searchParams.get('c');
  if (conversation && !/^conv_[A-Za-z0-9_-]+$/.test(conversation)) throw Error('Invalid conversation identity');
  const route = url.origin + url.pathname + (conversation ? '?c=' + conversation : ''); // Never retain tickets or auth/query strings.
  if (!['Runtime / DSH', 'Open Dot'].includes(input.provider) || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 500) throw Error('Invalid history snapshot');
  const messages = input.messages.map(row => {
    if (!['user', 'assistant', 'team'].includes(row.role) || typeof row.text !== 'string' || row.text.length > 100000) throw Error('Invalid cached message');
    return { role: row.role, text: row.text };
  });
  let framePath;
  if (input.framePath !== undefined) {
    if (!/^\/dots\/dot_[A-Za-z0-9_-]+$/.test(input.framePath)) throw Error('Invalid cached frame');
    framePath = input.framePath;
  }
  const value = { ...(framePath ? { framePath } : {}), route, provider: input.provider, title: String(input.title || 'Conversation').slice(0, 160), messages };
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw Error('History snapshot too large');
  return value;
}
module.exports = { OfflineHistoryStore, normalizeSnapshot };
