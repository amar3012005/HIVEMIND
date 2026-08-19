export function embeddingDimension() {
  return Math.max(1, Number(process.env.EMBEDDING_DIMENSION || 1024));
}

export function validateEmbeddingVector(vector, { dimension = embeddingDimension(), label = 'embedding' } = {}) {
  if (!Array.isArray(vector)) throw new Error(`${label} is not an array`);
  if (vector.length !== dimension) throw new Error(`${label} has dim=${vector.length}, want ${dimension}`);
  if (!vector.every(Number.isFinite)) throw new Error(`${label} contains non-finite values`);
  return vector;
}

export function isValidEmbeddingVector(vector, options = {}) {
  try { validateEmbeddingVector(vector, options); return true; }
  catch { return false; }
}

export function validateEmbeddingRows(vectors, count, options = {}) {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new Error(`embedding row count=${vectors?.length ?? 'none'}, want ${count}`);
  }
  return vectors.map((vector, index) => validateEmbeddingVector(vector, {
    ...options, label: `${options.label || 'embedding'}[${index}]`,
  }));
}

