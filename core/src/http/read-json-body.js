export class HttpBodyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function readBodyBuffer(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new HttpBodyError('Request body too large', 413);
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function readJsonBody(req, maxBytes) {
  const raw = await readBodyBuffer(req, maxBytes);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpBodyError('Invalid JSON body', 400); }
}
