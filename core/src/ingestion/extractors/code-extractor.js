const path = require('path');

const EXTENSION_LANGUAGE = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
};

function detectLanguage(filepath = '', fallback = 'plaintext') {
  const ext = path.extname(filepath).toLowerCase();
  return EXTENSION_LANGUAGE[ext] || fallback;
}

async function extractCode(payload) {
  const language = payload.language || detectLanguage(payload.filepath || payload.path || payload.title || '');
  const content = String(payload.content || '');

  return {
    title: payload.title || payload.filepath || 'Code document',
    language,
    pages: [{ page_number: 1, content }],
    content,
    metadata: {
      ...payload.metadata,
      filepath: payload.filepath,
      extraction_method: 'raw-file',
    },
  };
}

module.exports = {
  extractCode,
  detectLanguage,
};
