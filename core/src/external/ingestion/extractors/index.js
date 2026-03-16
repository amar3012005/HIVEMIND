const { extractText } = require('./text-extractor');
const { extractUrl } = require('./url-extractor');
const { extractPdf } = require('./pdf-extractor');
const { extractCode } = require('./code-extractor');
const { extractConversation } = require('./conversation-extractor');

const EXTRACTOR_BY_TYPE = {
  text: extractText,
  url: extractUrl,
  pdf: extractPdf,
  code: extractCode,
  conversation: extractConversation,
};

async function extractBySourceType(payload) {
  const extractor = EXTRACTOR_BY_TYPE[payload.source_type];
  if (!extractor) {
    throw new Error(`Unsupported source_type: ${payload.source_type}`);
  }

  return extractor(payload);
}

module.exports = {
  extractBySourceType,
};
