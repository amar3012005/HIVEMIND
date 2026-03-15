const SOURCE_TYPES = new Set(['text', 'url', 'pdf', 'code', 'conversation']);

const STAGES = Object.freeze({
  QUEUED: 'Queued',
  EXTRACTING: 'Extracting',
  CHUNKING: 'Chunking',
  EMBEDDING: 'Embedding',
  INDEXING: 'Indexing',
  DONE: 'Done',
  FAILED: 'Failed',
});

const STAGE_SEQUENCE = [
  STAGES.QUEUED,
  STAGES.EXTRACTING,
  STAGES.CHUNKING,
  STAGES.EMBEDDING,
  STAGES.INDEXING,
  STAGES.DONE,
];

module.exports = {
  SOURCE_TYPES,
  STAGES,
  STAGE_SEQUENCE,
};
