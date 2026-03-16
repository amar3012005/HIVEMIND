const STRUCTURAL_PATTERN = /\b(class|function|interface|type|enum|const|let|var|def)\b/;
const MAX_NWS_CHARS = 1500;

function removeWhitespaceCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function splitByStructuralHints(content) {
  const lines = String(content || '').split('\n');
  const nodes = [];
  let buffer = [];
  let scopeChain = [];

  for (const line of lines) {
    if (STRUCTURAL_PATTERN.test(line) && buffer.length > 0) {
      nodes.push({ content: buffer.join('\n'), scope_chain: scopeChain.join(' > ') || 'global' });
      buffer = [];
    }

    const scopeMatch = line.match(/(?:class|function|interface|def)\s+([A-Za-z0-9_]+)/);
    if (scopeMatch) {
      scopeChain = [scopeMatch[1]];
    }

    buffer.push(line);
  }

  if (buffer.length > 0) {
    nodes.push({ content: buffer.join('\n'), scope_chain: scopeChain.join(' > ') || 'global' });
  }

  return nodes;
}

function recurseOversizedNode(node, maxChars) {
  if (removeWhitespaceCount(node.content) <= maxChars) {
    return [node];
  }

  const midpoint = Math.floor(node.content.length / 2);
  const left = node.content.slice(0, midpoint);
  const right = node.content.slice(midpoint);

  return [
    ...recurseOversizedNode({ content: left, scope_chain: node.scope_chain }, maxChars),
    ...recurseOversizedNode({ content: right, scope_chain: node.scope_chain }, maxChars),
  ];
}

function greedyWindow(nodes, maxChars) {
  const chunks = [];
  let current = { content: '', scope_chain: '' };

  for (const node of nodes) {
    const nextContent = current.content ? `${current.content}\n${node.content}` : node.content;
    const nextSize = removeWhitespaceCount(nextContent);

    if (nextSize <= maxChars) {
      current = {
        content: nextContent,
        scope_chain: current.scope_chain || node.scope_chain,
      };
      continue;
    }

    if (current.content) {
      chunks.push(current);
    }

    const normalizedNodes = recurseOversizedNode(node, maxChars);
    if (normalizedNodes.length === 1 && removeWhitespaceCount(normalizedNodes[0].content) <= maxChars) {
      current = normalizedNodes[0];
    } else {
      chunks.push(...normalizedNodes.slice(0, -1));
      current = normalizedNodes[normalizedNodes.length - 1];
    }
  }

  if (current.content) {
    chunks.push(current);
  }

  return mergeUndersized(chunks, maxChars);
}

function mergeUndersized(chunks, maxChars) {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged = [];

  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(chunk);
      continue;
    }

    const combined = `${last.content}\n${chunk.content}`;
    if (removeWhitespaceCount(last.content) < Math.floor(maxChars / 3) && removeWhitespaceCount(combined) <= maxChars) {
      merged[merged.length - 1] = {
        content: combined,
        scope_chain: last.scope_chain || chunk.scope_chain,
      };
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

function extractSignature(content) {
  const text = String(content || '');
  const asyncMethod = text.match(/async\s+([A-Za-z0-9_]+)\s*\([^)]*\)/);
  if (asyncMethod) {
    return `async function ${asyncMethod[1]}(...)`;
  }

  const func = text.match(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)/);
  if (func) {
    return `function ${func[1]}(...)`;
  }

  const py = text.match(/def\s+([A-Za-z0-9_]+)\s*\([^)]*\)/);
  if (py) {
    return `def ${py[1]}(...)`;
  }

  return null;
}

function extractImports(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import ') || line.startsWith('from '))
    .slice(0, 25);
}

function chunkCodeAST(content) {
  const nodes = splitByStructuralHints(content);
  const windows = greedyWindow(nodes, MAX_NWS_CHARS);

  return windows.map((chunk, index) => ({
    chunk_index: index,
    content: chunk.content,
    scope_chain: chunk.scope_chain || 'global',
    metadata: {
      chunk_strategy: 'ast-aware',
      max_nws_chars: MAX_NWS_CHARS,
      signature: extractSignature(chunk.content),
      imports: extractImports(chunk.content),
    },
  }));
}

module.exports = {
  chunkCodeAST,
  removeWhitespaceCount,
  MAX_NWS_CHARS,
};
