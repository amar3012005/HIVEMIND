/**
 * Syntax-Aware Chunker using Tree-sitter AST
 * Greedy window assignment with AST-aware merging
 */

import { getASTParser } from './ast/parser.js';
import { getScopeChainBuilder } from './ast/scope.js';
import { getNWSCalculator } from './ast/density.js';

/**
 * Syntax Chunker class for AST-aware code chunking
 */
export class SyntaxChunker {
  constructor() {
    this.astParser = getASTParser();
    this.scopeBuilder = getScopeChainBuilder();
    this.nwsCalculator = getNWSCalculator();
    this.maxChunkSize = 1500; // Characters
    this.minChunkSize = 100;
    this.overlap = 100;
  }

  /**
   * Chunk source code using AST-aware algorithm
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Array} Array of chunks with metadata
   */
  chunk(code, language) {
    // Step 1: Parse AST
    const rootNode = this.astParser.parse(code, language);

    // Step 2: Build scope chain for all nodes
    const scopes = this.scopeBuilder.buildAllScopes(rootNode, language);

    // Step 3: Greedy window assignment
    const rawChunks = this._greedyWindowAssignment(rootNode, code, language);

    // Step 4: Merge small chunks
    const mergedChunks = this.nwsCalculator.mergeSmallChunks(rawChunks);

    // Step 5: Enrich with metadata
    return mergedChunks.map((chunk, index) => ({
      ...chunk,
      index,
      language,
      scopeChain: this._getScopeForChunk(chunk, scopes),
      nwsDensity: this.nwsCalculator.calculateChunkDensity(chunk).density,
      signature: this._extractSignature(chunk, code, language),
      imports: this._extractImports(rootNode, code, language),
      docstrings: this._extractDocstrings(rootNode, chunk, language),
      astNodeCount: this._countASTNodes(chunk, code, language)
    }));
  }

  /**
   * Greedy window assignment algorithm
   * @param {Object} rootNode - AST root node
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Array} Array of raw chunks
   */
  _greedyWindowAssignment(rootNode, code, language) {
    const chunks = [];
    const nodes = this._collectNodes(rootNode);

    let currentChunk = { text: '', start: 0, end: 0 };
    let nodeIndex = 0;

    while (nodeIndex < nodes.length) {
      const node = nodes[nodeIndex];
      const nodeText = code.substring(node.startIndex, node.endIndex);

      // Try adding node to current chunk
      const testChunk = {
        text: currentChunk.text + (currentChunk.text ? '\n' : '') + nodeText,
        start: currentChunk.start,
        end: node.endIndex
      };

      const density = this.nwsCalculator.calculateChunkDensity(testChunk);

      // Check if adding node would exceed limits
      const wouldExceedSize = testChunk.text.length > this.maxChunkSize;
      const wouldExceedOverlap = currentChunk.text.length > 0 &&
        testChunk.text.length - currentChunk.text.length > this.overlap;

      if (wouldExceedSize || wouldExceedOverlap) {
        // Finalize current chunk
        if (currentChunk.text.length >= this.minChunkSize || chunks.length === 0) {
          chunks.push(currentChunk);
        }
        currentChunk = { text: nodeText, start: node.startIndex, end: node.endIndex };
      } else {
        // Add node to current chunk
        currentChunk = testChunk;
      }

      nodeIndex++;
    }

    // Add final chunk
    if (currentChunk.text.length >= this.minChunkSize || chunks.length === 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Collect all relevant nodes from AST
   * @param {Object} rootNode - AST root node
   * @returns {Array} Array of relevant nodes
   */
  _collectNodes(rootNode) {
    const nodes = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      // Keep only structural nodes that are not already covered by a relevant parent.
      if (this._isRelevantNode(node) && !this._hasRelevantAncestor(node)) {
        nodes.push(node);
      }

      // Add children to stack
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    // Sort by position
    return nodes.sort((a, b) => a.startIndex - b.startIndex);
  }

  _hasRelevantAncestor(node) {
    let current = node.parent;
    while (current) {
      if (this._isRelevantNode(current)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if node is relevant for chunking
   * @param {Object} node - AST node
   * @returns {boolean} True if node is relevant
   */
  _isRelevantNode(node) {
    const relevantTypes = [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'function_definition',
      'method_declaration',
      'class_definition',
      'variable_declaration',
      'import_statement',
      'export_statement'
    ];

    return relevantTypes.includes(node.type) &&
           node.text.length > 0 &&
           node.text.length < 5000; // Skip huge nodes
  }

  /**
   * Get scope chain for a chunk
   * @param {Object} chunk - Chunk object
   * @param {Array} scopes - Array of scope objects
   * @returns {string} Formatted scope chain string
   */
  _getScopeForChunk(chunk, scopes) {
    const chunkStart = chunk.start;

    // Find the deepest scope that contains this chunk
    const matchingScope = scopes.find(scope =>
      chunkStart >= (scope.start?.character || 0) &&
      chunkStart <= (scope.end?.character || Infinity)
    );

    return matchingScope ? matchingScope.scopeChain : 'global';
  }

  /**
   * Extract function signature from chunk
   * @param {Object} chunk - Chunk object
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {string|null} Function signature or null
   */
  _extractSignature(chunk, code, language) {
    // For JavaScript/TypeScript
    if (language === 'javascript' || language === 'typescript') {
      // Match async functions and methods
      const funcMatch = chunk.text.match(/async\s+(\w+)\s*\([^)]*\)/);
      if (funcMatch) {
        return `async function ${funcMatch[1]}(...)`;
      }

      // Match regular functions
      const regularFuncMatch = chunk.text.match(/function\s+(\w+)\s*\([^)]*\)/);
      if (regularFuncMatch) {
        return `function ${regularFuncMatch[1]}(...)`;
      }

      // Match arrow functions
      const arrowMatch = chunk.text.match(/(\w+)\s*=\s*\([^)]*\)\s*=>/);
      if (arrowMatch) {
        return `const ${arrowMatch[1]} = (...) =>`;
      }
    }

    // For Python
    if (language === 'python') {
      const defMatch = chunk.text.match(/def\s+(\w+)\s*\([^)]*\)/);
      if (defMatch) {
        return `def ${defMatch[1]}(...)`;
      }
    }

    return null;
  }

  /**
   * Extract imports from AST
   * @param {Object} rootNode - AST root node
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Array} Array of import source strings
   */
  _extractImports(rootNode, code, language) {
    return this.astParser.getImports(rootNode, language);
  }

  /**
   * Extract docstrings from AST
   * @param {Object} rootNode - AST root node
   * @param {Object} chunk - Chunk object
   * @param {string} language - Language identifier
   * @returns {Array} Array of docstring texts
   */
  _extractDocstrings(rootNode, chunk, language) {
    return this.astParser.getDocstrings(rootNode, language);
  }

  /**
   * Count AST nodes in chunk
   * @param {Object} chunk - Chunk object
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {number} Number of AST nodes in chunk
   */
  _countASTNodes(chunk, code, language) {
    const rootNode = this.astParser.parse(code, language);
    let count = 0;
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node.startIndex >= (chunk.start || 0) &&
          node.endIndex <= (chunk.end || Infinity)) {
        count++;
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return count;
  }

  /**
   * Compare chunking strategies
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Object} Comparison results
   */
  compareStrategies(code, language) {
    const astChunks = this.chunk(code, language);
    const textChunks = this._textBasedChunking(code);

    return {
      ast: {
        count: astChunks.length,
        avgSize: this._avgSize(astChunks),
        avgDensity: this._avgDensity(astChunks),
        scopeCoverage: astChunks.filter(c => c.scopeChain !== 'global').length / astChunks.length
      },
      text: {
        count: textChunks.length,
        avgSize: this._avgSize(textChunks),
        avgDensity: this._avgDensity(textChunks)
      }
    };
  }

  /**
   * Calculate average size of chunks
   * @param {Array} chunks - Array of chunk objects
   * @returns {number} Average size
   */
  _avgSize(chunks) {
    return chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length;
  }

  /**
   * Calculate average density of chunks
   * @param {Array} chunks - Array of chunk objects
   * @returns {number} Average density
   */
  _avgDensity(chunks) {
    return chunks.reduce((sum, c) => sum + this.nwsCalculator.calculateChunkDensity(c).density, 0) / chunks.length;
  }

  /**
   * Text-based chunking for comparison
   * @param {string} code - Source code
   * @returns {Array} Array of text chunks
   */
  _textBasedChunking(code) {
    const chunks = [];
    const chunkSize = 1500;
    const overlap = 100;

    let position = 0;
    while (position < code.length) {
      chunks.push({
        text: code.substring(position, position + chunkSize),
        start: position,
        end: position + chunkSize
      });
      position += chunkSize - overlap;
    }

    return chunks;
  }

  /**
   * Get chunk statistics
   * @param {Array} chunks - Array of chunk objects
   * @returns {Object} Statistics object
   */
  getChunkStats(chunks) {
    const densities = chunks.map(c => c.nwsDensity);
    const sizes = chunks.map(c => c.text.length);

    return {
      chunkCount: chunks.length,
      avgSize: sizes.reduce((a, b) => a + b, 0) / chunks.length,
      minSize: Math.min(...sizes),
      maxSize: Math.max(...sizes),
      avgDensity: densities.reduce((a, b) => a + b, 0) / chunks.length,
      minDensity: Math.min(...densities),
      maxDensity: Math.max(...densities),
      scopeCoverage: chunks.filter(c => c.scopeChain !== 'global').length / chunks.length
    };
  }

  /**
   * Chunk multiple files
   * @param {Array} files - Array of {code, language, filename} objects
   * @returns {Array} Array of all chunks with metadata
   */
  chunkMultiple(files) {
    const allChunks = [];

    for (const file of files) {
      const chunks = this.chunk(file.code, file.language);
      chunks.forEach(chunk => {
        chunk.filename = file.filename;
      });
      allChunks.push(...chunks);
    }

    return allChunks;
  }

  /**
   * Get high-quality chunks (density > 0.7)
   * @param {Array} chunks - Array of chunk objects
   * @returns {Array} High-quality chunks
   */
  getHighQualityChunks(chunks) {
    return chunks.filter(chunk => chunk.nwsDensity > 0.7);
  }
}

// Singleton instance
let syntaxChunker = null;

/**
 * Get singleton SyntaxChunker instance
 * @returns {SyntaxChunker} Syntax chunker instance
 */
export function getSyntaxChunker() {
  if (!syntaxChunker) {
    syntaxChunker = new SyntaxChunker();
  }
  return syntaxChunker;
}
