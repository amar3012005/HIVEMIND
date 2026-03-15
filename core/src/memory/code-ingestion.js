import { getSyntaxChunker } from '../chunker.ast.js';

const syntaxChunker = getSyntaxChunker();

function isCodeFile(filepath) {
  if (!filepath) return false;
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.cs', '.h'];
  return extensions.some(ext => filepath.endsWith(ext));
}

function detectLanguage(filepath) {
  if (!filepath) return 'javascript';

  const ext = filepath.split('.').pop().toLowerCase();
  const extMap = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp'
  };

  return extMap[ext] || 'javascript';
}

function chunkDocumentText(content) {
  const chunks = [];
  const chunkSize = 1200;
  const overlap = 150;
  let position = 0;
  let chunkIndex = 0;

  while (position < content.length) {
    const text = content.substring(position, position + chunkSize);
    chunks.push({
      text,
      start: position,
      end: position + text.length,
      chunkIndex
    });
    chunkIndex += 1;
    position += chunkSize - overlap;
  }

  return chunks;
}

function toScopeChain(scopeChain) {
  if (Array.isArray(scopeChain)) return scopeChain.filter(Boolean);
  if (typeof scopeChain === 'string' && scopeChain.trim()) {
    return scopeChain.split('>').map(part => part.trim()).filter(Boolean);
  }
  return ['global'];
}

function inferEntityName(signature, scopeChain) {
  if (signature) {
    const match = signature.match(/(?:async function|function|def|const)\s+([A-Za-z0-9_]+)/);
    if (match) {
      return match[1];
    }
  }

  const chain = toScopeChain(scopeChain);
  return chain[chain.length - 1] || null;
}

function inferEntityType(signature, scopeChain) {
  const chain = toScopeChain(scopeChain);
  if (chain.length > 1) return 'member';
  if (!signature) return null;
  if (signature.startsWith('class ')) return 'class';
  if (signature.startsWith('def ')) return 'function';
  if (signature.startsWith('function ')) return 'function';
  if (signature.startsWith('async function ')) return 'function';
  if (signature.startsWith('const ')) return 'function';
  return null;
}

function computeLineNumber(content, index) {
  if (!content || index <= 0) return 1;
  return content.slice(0, index).split('\n').length;
}

function buildAstMetadata(chunk) {
  return {
    scopeChain: toScopeChain(chunk.scopeChain),
    signature: chunk.signature || null,
    imports: chunk.imports || [],
    docstrings: chunk.docstrings || [],
    nwsDensity: chunk.nwsDensity || null,
    astNodeCount: chunk.astNodeCount || null
  };
}

export function extractCodeChunks({ content, filepath, language }) {
  const resolvedLanguage = language || detectLanguage(filepath);
  let chunks;

  if (isCodeFile(filepath)) {
    try {
      chunks = syntaxChunker.chunk(content, resolvedLanguage).map((chunk, index) => ({
        ...chunk,
        chunkIndex: chunk.index ?? index
      }));
    } catch {
      chunks = chunkDocumentText(content);
    }
  } else {
    chunks = chunkDocumentText(content);
  }

  return chunks.map((chunk, index) => {
    const astMetadata = buildAstMetadata(chunk);
    const scopeChain = astMetadata.scopeChain;
    const signature = astMetadata.signature;

    return {
      text: chunk.text,
      chunk_index: chunk.chunkIndex ?? index,
      chunk_start: chunk.start ?? 0,
      chunk_end: chunk.end ?? ((chunk.start ?? 0) + chunk.text.length),
      ast_metadata: astMetadata,
      code_metadata: {
        filepath,
        language: resolvedLanguage,
        entity_type: inferEntityType(signature, scopeChain),
        entity_name: inferEntityName(signature, scopeChain),
        start_line: computeLineNumber(content, chunk.start ?? 0),
        end_line: computeLineNumber(content, chunk.end ?? ((chunk.start ?? 0) + chunk.text.length)),
        scope_chain: scopeChain,
        signatures: signature ? [signature] : [],
        imports: astMetadata.imports,
        dependencies: astMetadata.imports,
        nws_count: chunk.text.replace(/\s+/g, '').length,
        metadata: {
          chunk_index: chunk.chunkIndex ?? index,
          chunk_start: chunk.start ?? 0,
          chunk_end: chunk.end ?? ((chunk.start ?? 0) + chunk.text.length),
          docstrings: astMetadata.docstrings,
          nws_density: astMetadata.nwsDensity,
          ast_node_count: astMetadata.astNodeCount
        }
      }
    };
  });
}

export function detectCodeLanguage(filepath) {
  return detectLanguage(filepath);
}
