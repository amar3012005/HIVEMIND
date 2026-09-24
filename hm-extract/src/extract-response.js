const RESPONSE_CHUNK_BYTES = 64 * 1024;

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('error', onError);
      res.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('client closed while extraction response was streaming')); };
    res.once('drain', onDrain);
    res.once('error', onError);
    res.once('close', onClose);
  });
}

async function writeWithBackpressure(res, value) {
  if (!res.write(value)) await waitForDrain(res);
}

/**
 * Stream an extraction JSON response with bounded socket buffering.
 *
 * Express's res.json() materializes one enormous serialized response. The
 * previous hand-written writer avoided that allocation but ignored write()
 * backpressure, allowing large segment arrays to accumulate in Node's socket
 * buffer. This writer batches small records and pauses whenever the client is
 * slower than the parser. `compact` is negotiated by the internal Core client:
 * the legacy response retains both text aliases, while v2 sends the same text
 * once under `text`.
 */
export async function writeExtractResponse(res, {
  engine, format, chars, markdown, text, pageMarks, segments, structuralDensity, timings,
}, { compact = false } = {}) {
  res.status(200);
  res.set('Content-Type', 'application/json');
  await writeWithBackpressure(res, '{"ok":true');
  for (const [key, value] of [
    ['engine', engine], ['format', format], ['chars', chars],
  ]) await writeWithBackpressure(res, `,${JSON.stringify(key)}:${JSON.stringify(value)}`);
  if (!compact) await writeWithBackpressure(res, `,"markdown":${JSON.stringify(markdown)}`);
  await writeWithBackpressure(res, `,"text":${JSON.stringify(text)}`);
  await writeWithBackpressure(res, `,"page_marks":${JSON.stringify(pageMarks)}`);
  await writeWithBackpressure(res, ',"segments":[');

  let batch = '';
  let batchBytes = 0;
  let first = true;
  for (const segment of segments) {
    const serialized = `${first ? '' : ','}${JSON.stringify(segment)}`;
    const serializedBytes = Buffer.byteLength(serialized);
    first = false;
    if (batch && batchBytes + serializedBytes > RESPONSE_CHUNK_BYTES) {
      await writeWithBackpressure(res, batch);
      batch = '';
      batchBytes = 0;
    }
    if (serializedBytes > RESPONSE_CHUNK_BYTES) {
      if (batch) { await writeWithBackpressure(res, batch); batch = ''; batchBytes = 0; }
      await writeWithBackpressure(res, serialized);
    } else { batch += serialized; batchBytes += serializedBytes; }
  }
  if (batch) await writeWithBackpressure(res, batch);
  await writeWithBackpressure(res, `],"structural_density":${JSON.stringify(structuralDensity)}`);
  await writeWithBackpressure(res, `,"timings":${JSON.stringify(timings)}}`);
  res.end();
}
