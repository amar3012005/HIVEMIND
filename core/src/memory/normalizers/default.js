// No-op normalizer for providers without bespoke noise stripping.
// Returns content + metadata unchanged so the bucket router can run
// chunking and tree assembly without special-casing missing providers.
export const defaultNormalizer = {
  name: 'default',
  normalize(content, metadata = {}) {
    return { content: content || '', metadata };
  },
};
