import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type ConnectionRecord = {
  provider: 'hivemind';
  accessToken: string;
  refreshToken: string;
  scope: string;
  workspaceId: string | null;
  connectedAt: string;
};

const STORE_PATH = path.join(process.cwd(), '.data', 'hivemind-connection.json');

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getKey() {
  const secret = process.env.THIRDPARTY_TOKEN_ENCRYPTION_KEY || 'change-me-in-production';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
  } catch {
    return null;
  }
}

export function saveConnection(record: ConnectionRecord): void {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify({ payload: encrypt(JSON.stringify(record)) }, null, 2), 'utf8');
}

export function loadConnection(): ConnectionRecord | null {
  try {
    if (!fs.existsSync(STORE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const plaintext = decrypt(raw.payload || '');
    if (!plaintext) return null;
    return JSON.parse(plaintext) as ConnectionRecord;
  } catch {
    return null;
  }
}

export function clearConnection(): void {
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
}
