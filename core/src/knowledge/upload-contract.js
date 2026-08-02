import path from 'node:path';

export const KB_UPLOAD_LIMITS = Object.freeze({
  document: { minBytes: 32, maxBytes: 50 * 1024 * 1024 },
  image: { minBytes: 1, maxBytes: 20 * 1024 * 1024 },
  audio: { minBytes: 1, maxBytes: 50 * 1024 * 1024 },
});

export const KB_EXTENSIONS = Object.freeze({
  document: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'markdown', 'csv', 'tsv', 'html', 'htm'],
  image: ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'webp', 'gif'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg'],
});

const MIME_PREFIX = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
  webp: ['image/webp'], gif: ['image/gif'], mp3: ['audio/mpeg'], wav: ['audio/wav', 'audio/x-wav'],
  m4a: ['audio/mp4', 'audio/x-m4a'],
};

export function safeUploadFilename(input) {
  return path.basename(String(input || 'upload'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ ()\-+]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 240) || 'upload';
}

export function classifyKnowledgeFile(filename, contentType = '') {
  const ext = safeUploadFilename(filename).split('.').pop()?.toLowerCase() || '';
  const kind = Object.entries(KB_EXTENSIONS).find(([, exts]) => exts.includes(ext))?.[0] || null;
  if (!kind) return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', ext, kind: null };
  const allowedMimes = MIME_PREFIX[ext];
  if (allowedMimes && contentType && !allowedMimes.includes(String(contentType).toLowerCase())) {
    return { ok: false, code: 'MIME_EXTENSION_MISMATCH', ext, kind };
  }
  return { ok: true, ext, kind, limits: KB_UPLOAD_LIMITS[kind] };
}

function hasExpectedSignature(ext, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return true;
  const ascii = buffer.subarray(0, 12).toString('ascii');
  const hex = buffer.subarray(0, 12).toString('hex');
  if (ext === 'pdf') return ascii.startsWith('%PDF-');
  if (ext === 'png') return hex.startsWith('89504e470d0a1a0a');
  if (ext === 'jpg' || ext === 'jpeg') return hex.startsWith('ffd8ff');
  if (ext === 'gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
  if (ext === 'webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  if (['docx', 'xlsx', 'pptx'].includes(ext)) return hex.startsWith('504b0304');
  if (ext === 'wav') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE';
  if (ext === 'mp3') return ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2');
  return true;
}

export function validateKnowledgeFile({ filename, contentType, bytes, buffer = null }) {
  const file = classifyKnowledgeFile(filename, contentType);
  if (!file.ok) return file;
  const size = Number(bytes) || 0;
  if (size < file.limits.minBytes) return { ...file, ok: false, code: size === 0 ? 'FILE_EMPTY' : 'FILE_TOO_SMALL' };
  if (size > file.limits.maxBytes) return { ...file, ok: false, code: 'FILE_TOO_LARGE' };
  if (!hasExpectedSignature(file.ext, buffer)) return { ...file, ok: false, code: 'FILE_SIGNATURE_MISMATCH' };
  return { ...file, size };
}

export function knowledgeUploadCapabilities() {
  return {
    version: 1,
    endpoint: '/api/knowledge/upload',
    asynchronous: true,
    kinds: Object.fromEntries(Object.entries(KB_UPLOAD_LIMITS).map(([kind, limits]) => [kind, {
      ...limits, extensions: KB_EXTENSIONS[kind],
    }])),
    scopes: ['personal', 'project', 'team', 'organization'],
  };
}

export function uploadError(code, details = {}) {
  const messages = {
    FILE_EMPTY: 'The uploaded file is empty.',
    FILE_TOO_SMALL: 'The uploaded file is too small to contain usable content.',
    FILE_TOO_LARGE: 'The uploaded file exceeds the limit for this file type.',
    UNSUPPORTED_FILE_TYPE: 'This file type is not supported.',
    MIME_EXTENSION_MISMATCH: 'The file contents do not match its filename.',
    FILE_SIGNATURE_MISMATCH: 'The file contents do not match its filename.',
  };
  const status = code === 'FILE_TOO_LARGE' ? 413 : ['UNSUPPORTED_FILE_TYPE', 'MIME_EXTENSION_MISMATCH', 'FILE_SIGNATURE_MISMATCH'].includes(code) ? 415 : 400;
  return { status, body: { error: code.toLowerCase(), code, message: messages[code] || 'Invalid upload.', ...details } };
}
