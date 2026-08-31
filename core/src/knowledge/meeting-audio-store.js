import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_ROOT = '/app/data/meeting-audio';

export function meetingAudioRoot() {
  return path.resolve(process.env.MEETING_AUDIO_STORE_DIR || DEFAULT_ROOT);
}

// A container-local path is adequate for tests only. Production must opt in
// explicitly after mounting a persistent tenant-approved volume (or wiring an
// object-store adapter); otherwise returning 202 would be a false durability
// claim during a container replacement.
export function meetingAudioStoreIsDurable() {
  return process.env.NODE_ENV !== 'production'
    || ['1', 'true', 'yes', 'on'].includes(String(process.env.MEETING_AUDIO_STORE_DURABLE || '').toLowerCase());
}

export function audioExtension(contentType = '') {
  const type = String(contentType).split(';')[0].toLowerCase();
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

export function meetingAudioStorageKey({ orgId, sessionId, idx, checksum, contentType }) {
  // ids are UUIDs from authenticated route/session lookup, but validate anyway:
  // storage keys must never be influenced by a traversal-capable client string.
  for (const value of [orgId, sessionId]) if (!/^[0-9a-f-]{36}$/i.test(String(value))) throw new Error('invalid meeting storage owner');
  if (!Number.isInteger(Number(idx)) || Number(idx) < 0) throw new Error('invalid meeting segment index');
  if (!/^[a-f0-9]{64}$/i.test(String(checksum))) throw new Error('invalid meeting audio checksum');
  // Persisted object keys are platform-neutral identifiers, not host paths.
  // POSIX separators keep receipts stable across Windows local and Linux prod.
  return path.posix.join(String(orgId), String(sessionId), `${Number(idx)}-${checksum}.${audioExtension(contentType)}`);
}

function resolveKey(storageKey) {
  const root = meetingAudioRoot();
  const target = path.resolve(root, storageKey);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('invalid meeting audio storage key');
  return target;
}

export async function persistMeetingAudio({ orgId, sessionId, idx, contentType, bytes }) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  const checksum = crypto.createHash('sha256').update(data).digest('hex');
  const storageKey = meetingAudioStorageKey({ orgId, sessionId, idx, checksum, contentType });
  const target = resolveKey(storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.access(target); }
  catch {
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  return { storageKey, checksum, byteSize: data.length };
}

export async function readMeetingAudio(storageKey) {
  return fs.readFile(resolveKey(storageKey));
}

export async function removeMeetingAudio(storageKey) {
  await fs.rm(resolveKey(storageKey), { force: true });
}
