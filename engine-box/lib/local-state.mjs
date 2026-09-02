import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILE = 'setup.enc.json';
const ACTIVATION_FILE = 'activation.json';
const TOKEN_USED_FILE = 'setup-token.used';

function stateDir(env = process.env) {
  return env.ENGINE_BOX_STATE_DIR || '/var/lib/hivemind-engine/state';
}

async function readTrimmed(file) {
  return (await fs.readFile(file, 'utf8')).trim();
}

async function ensureStateDir(env) {
  await fs.mkdir(stateDir(env), { recursive: true, mode: 0o700 });
}

function requireKey(raw) {
  const key = Buffer.from(String(raw || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('Engine Box state key must be a 32-byte base64 value');
  return key;
}

async function stateKey(env) {
  if (!env.ENGINE_BOX_STATE_KEY_FILE) throw new Error('ENGINE_BOX_STATE_KEY_FILE is required');
  return requireKey(await readTrimmed(env.ENGINE_BOX_STATE_KEY_FILE));
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(envelope, key) {
  if (envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') throw new Error('Engine Box setup state is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function readSetupRecord(env = process.env) {
  try {
    const [raw, key] = await Promise.all([readTrimmed(path.join(stateDir(env), CONFIG_FILE)), stateKey(env)]);
    return decrypt(JSON.parse(raw), key);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeSetupRecord(record, env = process.env) {
  await ensureStateDir(env);
  const target = path.join(stateDir(env), CONFIG_FILE);
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(encrypt(record, await stateKey(env)))}\n`;
  await fs.writeFile(temp, payload, { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function readActivationReceipt(env = process.env) {
  try { return JSON.parse(await readTrimmed(path.join(stateDir(env), ACTIVATION_FILE))); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function writeActivationReceipt(receipt, env = process.env) {
  await ensureStateDir(env);
  const target = path.join(stateDir(env), ACTIVATION_FILE);
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await fs.rename(temp, target);
}

/** Setup authentication is one-time and local. The raw token never enters state. */
async function matchesSetupToken(candidate, env = process.env) {
  if (typeof candidate !== 'string' || candidate.length < 24) return false;
  const tokenFile = env.ENGINE_BOX_SETUP_TOKEN_FILE;
  if (!tokenFile) throw new Error('ENGINE_BOX_SETUP_TOKEN_FILE is required');
  const expected = await readTrimmed(tokenFile);
  const actualBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  return true;
}

export async function verifySetupToken(candidate, env = process.env) {
  const usedFile = path.join(stateDir(env), TOKEN_USED_FILE);
  try { await fs.access(usedFile); return false; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return matchesSetupToken(candidate, env);
}

export async function consumeSetupToken(candidate, env = process.env) {
  if (!(await verifySetupToken(candidate, env))) return false;
  const usedFile = path.join(stateDir(env), TOKEN_USED_FILE);
  await ensureStateDir(env);
  await fs.writeFile(usedFile, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  return true;
}

export function redactStoredSetup(record) {
  if (!record) return null;
  const copy = structuredClone(record);
  delete copy?.oidc?.client_secret;
  for (const route of Object.values(copy.model_routes || {})) delete route?.api_key;
  return copy;
}
