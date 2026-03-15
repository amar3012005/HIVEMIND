# Phase 2 Implementation Plan: AST-Aware Technical Intelligence

**Document Version:** 1.0  
**Date:** 2026-03-09  
**Status:** 🚧 IN PROGRESS  
**Priority:** P0 - Critical Path  

---

## Executive Summary

The AST-Aware Parser addresses the fundamental limitation of naive text chunking: **code fragmentation**. Traditional chunking cuts code in the middle of functions, destroying semantic meaning. This plan implements Tree-sitter-based parsing to create syntax-aware chunks that preserve callable units, scope chains, and technical context.

**Target:** Match Supermemory.ai's code-chunk with Tree-sitter for technical intelligence.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AST-AWARE PARSING PIPELINE                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│   Source     │    │   Tree-sitter    │    │   Scope Chain    │    │   Chunk      │
│   Code File  │───▶│   AST Parser     │───▶│   Construction   │───▶│   Generator  │
└──────────────┘    └──────────────────┘    └──────────────────┘    └──────────────┘
                                                         │
                                                         ▼
                                            ┌─────────────────────────────┐
                                            │   NWS Density Calculator    │
                                            │   • Non-Whitespace Chars    │
                                            │   • Logic Density Metric    │
                                            └─────────────────────────────┘
                                                         │
                                                         ▼
                                            ┌─────────────────────────────┐
                                            │   Metadata Enrichment       │
                                            │   • Scope Chain             │
                                            │   • Function Signatures     │
                                            │   • Import Mappings         │
                                            │   • Docstrings              │
                                            └─────────────────────────────┘
```

---

## Current State Gap Analysis

| Component | Current Implementation | Target (Supermemory) | Gap |
|-----------|----------------------|---------------------|-----|
| AST Parsing | ❌ None | ✅ Tree-sitter | **HIGH** |
| Scope Chain | ❌ None | ✅ Class > Method > Block | **HIGH** |
| NWS Density | ❌ None | ✅ Logic density metric | **HIGH** |
| Syntax-aware Chunking | ⚠️ Basic text split | ✅ AST-aware greedy window | **HIGH** |

---

## Implementation Steps

### Step 1: Tree-sitter Integration

**Effort:** 4 days  
**Dependencies:** None  
**Files:** `core/src/chunking/tree-sitter.js`

```javascript
/**
 * Tree-sitter AST Parser for Technical Intelligence
 * Supports JavaScript, TypeScript, Python, Go, Rust, Java, C#
 */

import Parser from 'web-tree-sitter';
import { readFileSync } from 'fs';

// Supported languages and their Tree-sitter parsers
const LANGUAGES = {
  javascript: { parser: 'tree-sitter-javascript', query: 'javascript' },
  typescript: { parser: 'tree-sitter-typescript', query: 'typescript' },
  python: { parser: 'tree-sitter-python', query: 'python' },
  go: { parser: 'tree-sitter-go', query: 'go' },
  rust: { parser: 'tree-sitter-rust', query: 'rust' },
  java: { parser: 'tree-sitter-java', query: 'java' },
  c: { parser: 'tree-sitter-c', query: 'c' },
  cpp: { parser: 'tree-sitter-cpp', query: 'cpp' },
  csharp: { parser: 'tree-sitter-c-sharp', query: 'c_sharp' }
};

export class ASTParser {
  constructor() {
    this.parsers = new Map();
    this.initialized = false;
  }

  /**
   * Initialize Tree-sitter parsers
   */
  async initialize() {
    if (this.initialized) return;

    await Parser.init();
    this.initialized = true;

    // Load parsers dynamically
    for (const [lang, config] of Object.entries(LANGUAGES)) {
      try {
        const ParserClass = await import(`tree-sitter-${config.parser}`);
        const parser = new Parser();
        parser.setLanguage(ParserClass);
        this.parsers.set(lang, parser);
      } catch (error) {
        console.warn(`Failed to load parser for ${lang}:`, error.message);
      }
    }
  }

  /**
   * Parse source code and return AST
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Object} AST root node
   */
  parse(code, language) {
    const parser = this.parsers.get(language);
    if (!parser) {
      throw new Error(`No parser available for language: ${language}`);
    }

    const tree = parser.parse(code);
    return tree.rootNode;
  }

  /**
   * Parse file and return AST
   * @param {string} filePath - Path to source file
   * @returns {Object} AST root node
   */
  parseFile(filePath) {
    const code = readFileSync(filePath, 'utf-8');
    const language = this._detectLanguage(filePath);
    return this.parse(code, language);
  }

  /**
   * Detect language from file extension
   */
  _detectLanguage(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    
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

  /**
   * Get all function declarations in AST
   */
  getFunctions(rootNode, language) {
    const functions = [];
    const query = this._getQuery(language, 'function');
    
    if (query) {
      const matches = query.matches(rootNode);
      for (const match of matches) {
        const capture = match.captures.find(c => c.name === 'name');
        if (capture) {
          functions.push({
            name: capture.node.text,
            start: capture.node.startPosition,
            end: capture.node.endPosition,
            body: capture.node.parent
          });
        }
      }
    }

    return functions;
  }

  /**
   * Get all class definitions in AST
   */
  getClasses(rootNode, language) {
    const classes = [];
    const query = this._getQuery(language, 'class');
    
    if (query) {
      const matches = query.matches(rootNode);
      for (const match of matches) {
        const capture = match.captures.find(c => c.name === 'name');
        if (capture) {
          classes.push({
            name: capture.node.text,
            start: capture.node.startPosition,
            end: capture.node.endPosition,
            body: capture.node.parent
          });
        }
      }
    }

    return classes;
  }

  /**
   * Get query for language-specific AST traversal
   */
  _getQuery(language, type) {
    const queries = {
      javascript: {
        function: `(function_declaration name: (identifier) @name)`,
        class: `(class_declaration name: (identifier) @name)`,
        method: `(method_definition name: (property_identifier) @name)`,
        variable: `(variable_declarator name: (identifier) @name)`
      },
      typescript: {
        function: `(function_declaration name: (identifier) @name)`,
        class: `(class_declaration name: (identifier) @name)`,
        method: `(method_definition name: (property_identifier) @name)`,
        interface: `(interface_declaration name: (identifier) @name)`,
        typeAlias: `(type_alias_declaration name: (identifier) @name)`
      },
      python: {
        function: `(function_definition name: (identifier) @name)`,
        class: `(class_definition name: (identifier) @name)`,
        method: `(method_definition name: (identifier) @name)`
      },
      go: {
        function: `(function_declaration name: (identifier) @name)`,
        method: `(method_declaration name: (field_identifier) @name)`,
        type: `(type_declaration name: (type_identifier) @name)`
      },
      rust: {
        function: `(function_item name: (identifier) @name)`,
        method: `(method_declaration name: (identifier) @name)`,
        struct: `(struct_item name: (type_identifier) @name)`,
        enum: `(enum_item name: (type_identifier) @name)`
      },
      java: {
        class: `(class_declaration name: (identifier) @name)`,
        method: `(method_declaration name: (identifier) @name)`,
        interface: `(interface_declaration name: (identifier) @name)`
      }
    };

    return queries[language]?.[type];
  }
}

// Singleton
let astParser = null;
export function getASTParser() {
  if (!astParser) {
    astParser = new ASTParser();
  }
  return astParser;
}
```

---

### Step 2: Scope Chain Construction

**Effort:** 3 days  
**Dependencies:** Step 1  
**Files:** `core/src/chunking/scope-chain.js`

```javascript
/**
 * Scope Chain Construction
 * Builds hierarchical path: Class > Method > Logic Block
 */

import { getASTParser } from './tree-sitter.js';

export class ScopeChainBuilder {
  constructor() {
    this.astParser = getASTParser();
  }

  /**
   * Build scope chain for a node
   * @param {Object} rootNode - AST root node
   * @param {Object} targetNode - Target node to find scope for
   * @param {string} language - Language identifier
   * @returns {string[]} Scope chain array
   */
  buildScopeChain(rootNode, targetNode, language) {
    const chain = [];
    const visited = new Set();

    // Walk up the tree from target node
    let current = targetNode;
    while (current) {
      const scopeInfo = this._extractScopeInfo(current, language);
      if (scopeInfo && !visited.has(current.id)) {
        visited.add(current.id);
        chain.unshift(scopeInfo);
      }
      current = current.parent;
    }

    return chain;
  }

  /**
   * Extract scope information from a node
   */
  _extractScopeInfo(node, language) {
    const type = node.type;
    
    const scopeMap = {
      function_declaration: { type: 'function', name: this._getName(node) },
      method_definition: { type: 'method', name: this._getName(node) },
      class_declaration: { type: 'class', name: this._getName(node) },
      interface_declaration: { type: 'interface', name: this._getName(node) },
      struct_item: { type: 'struct', name: this._getName(node) },
      enum_item: { type: 'enum', name: this._getName(node) },
      function_item: { type: 'function', name: this._getName(node) },
      method_declaration: { type: 'method', name: this._getName(node) },
      class_definition: { type: 'class', name: this._getName(node) },
      function_definition: { type: 'function', name: this._getName(node) },
      method_definition: { type: 'method', name: this._getName(node) }
    };

    return scopeMap[type] || null;
  }

  /**
   * Extract name from node
   */
  _getName(node) {
    if (!node) return 'anonymous';
    
    // Try to find name child
    const nameNode = node.children?.find(c => 
      c.type === 'identifier' || 
      c.type === 'property_identifier' ||
      c.type === 'type_identifier'
    );
    
    return nameNode?.text || 'anonymous';
  }

  /**
   * Format scope chain as string
   */
  formatScopeChain(chain) {
    return chain.map(item => `${item.type}:${item.name}`).join(' > ');
  }

  /**
   * Build scope chain for all functions in file
   */
  buildAllScopes(rootNode, language) {
    const scopes = [];
    const functions = this.astParser.getFunctions(rootNode, language);
    const classes = this.astParser.getClasses(rootNode, language);

    // Build scope for each function
    for (const func of functions) {
      const chain = this.buildScopeChain(rootNode, func.body, language);
      scopes.push({
        type: 'function',
        name: func.name,
        scopeChain: this.formatScopeChain(chain),
        start: func.start,
        end: func.end
      });
    }

    // Build scope for each class
    for (const cls of classes) {
      const chain = this.buildScopeChain(rootNode, cls.body, language);
      scopes.push({
        type: 'class',
        name: cls.name,
        scopeChain: this.formatScopeChain(chain),
        start: cls.start,
        end: cls.end
      });
    }

    return scopes;
  }

  /**
   * Find scope for a specific position
   */
  findScopeForPosition(rootNode, position, language) {
    const scopes = this.buildAllScopes(rootNode, language);
    
    return scopes.find(scope => 
      position.line >= scope.start.line &&
      position.line <= scope.end.line &&
      position.column >= scope.start.column &&
      position.column <= scope.end.column
    );
  }
}

// Singleton
let scopeChainBuilder = null;
export function getScopeChainBuilder() {
  if (!scopeChainBuilder) {
    scopeChainBuilder = new ScopeChainBuilder();
  }
  return scopeChainBuilder;
}
```

---

### Step 3: NWS Density Calculation

**Effort:** 2 days  
**Dependencies:** None  
**Files:** `core/src/chunking/nws-density.js`

```javascript
/**
 * NWS (Non-Whitespace) Density Calculator
 * Measures logic density for better chunk quality
 */

export class NWSDensityCalculator {
  constructor() {
    this.minDensity = 0.3; // Minimum acceptable density
    this.maxChunkSize = 1500; // Characters
  }

  /**
   * Calculate NWS density for text
   * @param {string} text - Text to analyze
   * @returns {Object} Density metrics
   */
  calculateDensity(text) {
    const totalChars = text.length;
    const whitespaceChars = (text.match(/\s/g) || []).length;
    const nonWhitespaceChars = totalChars - whitespaceChars;
    const density = totalChars > 0 ? nonWhitespaceChars / totalChars : 0;

    return {
      totalChars,
      whitespaceChars,
      nonWhitespaceChars,
      density,
      isAcceptable: density >= this.minDensity
    };
  }

  /**
   * Calculate density for AST node
   */
  calculateNodeDensity(node, code) {
    const nodeText = code.substring(node.startIndex, node.endIndex);
    return this.calculateDensity(nodeText);
  }

  /**
   * Calculate density for chunk
   */
  calculateChunkDensity(chunk) {
    return this.calculateDensity(chunk.text);
  }

  /**
   * Score chunk based on density and size
   */
  scoreChunk(chunk) {
    const density = this.calculateChunkDensity(chunk);
    const sizeScore = Math.min(chunk.text.length / this.maxChunkSize, 1);
    const densityScore = density.density;
    
    // Weighted combination
    return 0.4 * sizeScore + 0.6 * densityScore;
  }

  /**
   * Filter chunks by minimum density
   */
  filterByDensity(chunks) {
    return chunks.filter(chunk => 
      this.calculateChunkDensity(chunk).isAcceptable
    );
  }

  /**
   * Merge small chunks to improve density
   */
  mergeSmallChunks(chunks, minDensity = 0.3) {
    const merged = [];
    let currentChunk = { text: '', start: 0, end: 0 };

    for (const chunk of chunks) {
      const testChunk = {
        text: currentChunk.text + chunk.text,
        start: currentChunk.start,
        end: chunk.end
      };

      const density = this.calculateChunkDensity(testChunk);

      if (density.density >= minDensity && testChunk.text.length <= this.maxChunkSize) {
        currentChunk = testChunk;
      } else {
        if (currentChunk.text.length > 0) {
          merged.push(currentChunk);
        }
        currentChunk = { ...chunk };
      }
    }

    if (currentChunk.text.length > 0) {
      merged.push(currentChunk);
    }

    return merged;
  }

  /**
   * Get density statistics for array of chunks
   */
  getDensityStats(chunks) {
    const densities = chunks.map(c => this.calculateChunkDensity(c).density);
    
    return {
      min: Math.min(...densities),
      max: Math.max(...densities),
      avg: densities.reduce((a, b) => a + b, 0) / densities.length,
      median: this._median(densities),
      count: chunks.length
    };
  }

  _median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2 
      : sorted[mid];
  }
}

// Singleton
let nwsCalculator = null;
export function getNWSCalculator() {
  if (!nwsCalculator) {
    nwsCalculator = new NWSDensityCalculator();
  }
  return nwsCalculator;
}
```

---

### Step 4: Syntax-Aware Chunking Algorithm

**Effort:** 4 days  
**Dependencies:** Steps 1-3  
**Files:** `core/src/chunking/syntax-chunker.js`

```javascript
/**
 * Syntax-Aware Chunking
 * Greedy window assignment with AST-aware merging
 */

import { getASTParser } from './tree-sitter.js';
import { getScopeChainBuilder } from './scope-chain.js';
import { getNWSCalculator } from './nws-density.js';

export class SyntaxChunker {
  constructor() {
    this.astParser = getASTParser();
    this.scopeBuilder = getScopeChainBuilder();
    this.nwsCalculator = getNWSCalculator();
    this.maxChunkSize = 1500; // Characters
    this.minChunkSize = 100;
    this.overlap = 50;
  }

  /**
   * Chunk source code using AST-aware algorithm
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Object[]} Array of chunks with metadata
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
      imports: this._extractImports(rootNode, code, language)
    }));
  }

  /**
   * Greedy window assignment algorithm
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
        if (currentChunk.text.length >= this.minChunkSize) {
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
    if (currentChunk.text.length >= this.minChunkSize) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Collect all relevant nodes from AST
   */
  _collectNodes(rootNode) {
    const nodes = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();
      
      // Include function, class, and statement nodes
      if (this._isRelevantNode(node)) {
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

  /**
   * Check if node is relevant for chunking
   */
  _isRelevantNode(node) {
    const relevantTypes = [
      'function_declaration',
      'method_definition',
      'class_declaration',
      'function_definition',
      'method_declaration',
      'class_definition',
      'statement_block',
      'expression_statement',
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
   */
  _getScopeForChunk(chunk, scopes) {
    const chunkStart = chunk.start;
    
    // Find the deepest scope that contains this chunk
    const matchingScope = scopes.find(scope => 
      chunkStart >= scope.start.character &&
      chunkStart <= scope.end.character
    );

    return matchingScope ? matchingScope.scopeChain : 'global';
  }

  /**
   * Extract function signature from chunk
   */
  _extractSignature(chunk, code, language) {
    // For JavaScript/TypeScript
    if (language === 'javascript' || language === 'typescript') {
      const funcMatch = chunk.text.match(/function\s+(\w+)\s*\([^)]*\)/);
      if (funcMatch) {
        return `function ${funcMatch[1]}(...)`;
      }
      
      const arrowMatch = chunk.text.match(/(\w+)\s*=\s*\([^)]*\)\s*=>/);
      if (arrowMatch) {
        return `const ${arrowMatch[1]} = (...) =>`;
      }
    }

    return null;
  }

  /**
   * Extract imports from AST
   */
  _extractImports(rootNode, code, language) {
    const imports = [];
    const importTypes = ['import_statement', 'import_declaration'];

    const stack = [rootNode];
    while (stack.length > 0) {
      const node = stack.pop();
      
      if (importTypes.includes(node.type)) {
        const sourceNode = node.children?.find(c => 
          c.type === 'string' || c.type === 'string_literal'
        );
        
        if (sourceNode) {
          imports.push(sourceNode.text.replace(/['"]/g, ''));
        }
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return imports;
  }

  /**
   * Compare chunking strategies
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

  _avgSize(chunks) {
    return chunks.reduce((sum, c) => sum + c.text.length, 0) / chunks.length;
  }

  _avgDensity(chunks) {
    return chunks.reduce((sum, c) => sum + this.nwsCalculator.calculateChunkDensity(c).density, 0) / chunks.length;
  }

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
}

// Singleton
let syntaxChunker = null;
export function getSyntaxChunker() {
  if (!syntaxChunker) {
    syntaxChunker = new SyntaxChunker();
  }
  return syntaxChunker;
}
```

---

### Step 5: Metadata Enrichment

**Effort:** 2 days  
**Dependencies:** Steps 1-4  
**Files:** `core/src/chunking/enrichment.js`

```javascript
/**
 * Metadata Enrichment
 * Adds scope chain, signatures, imports, docstrings to chunks
 */

import { getASTParser } from './tree-sitter.js';
import { getScopeChainBuilder } from './scope-chain.js';
import { getSyntaxChunker } from './syntax-chunker.js';

export class MetadataEnricher {
  constructor() {
    this.astParser = getASTParser();
    this.scopeBuilder = getScopeChainBuilder();
    this.chunker = getSyntaxChunker();
  }

  /**
   * Enrich a single chunk with all metadata
   */
  enrichChunk(chunk, code, language) {
    const rootNode = this.astParser.parse(code, language);
    
    return {
      ...chunk,
      scopeChain: this._buildScopeChain(rootNode, chunk, language),
      signature: this._extractSignature(chunk, code, language),
      imports: this._extractImports(rootNode, code, language),
      docstrings: this._extractDocstrings(rootNode, chunk, language),
      nwsDensity: this._calculateNWS(chunk.text),
      astNodeCount: this._countASTNodes(chunk, code, language)
    };
  }

  /**
   * Build scope chain for chunk
   */
  _buildScopeChain(rootNode, chunk, language) {
    const scopes = this.scopeBuilder.buildAllScopes(rootNode, language);
    const chunkStart = chunk.start || 0;
    
    const matchingScope = scopes.find(scope => 
      chunkStart >= (scope.start?.character || 0) &&
      chunkStart <= (scope.end?.character || Infinity)
    );

    return matchingScope ? matchingScope.scopeChain : 'global';
  }

  /**
   * Extract function signature
   */
  _extractSignature(chunk, code, language) {
    if (language === 'javascript' || language === 'typescript') {
      const funcMatch = chunk.text.match(/function\s+(\w+)\s*\([^)]*\)/);
      if (funcMatch) return `function ${funcMatch[1]}(...)`;
      
      const arrowMatch = chunk.text.match(/(\w+)\s*=\s*\([^)]*\)\s*=>/);
      if (arrowMatch) return `const ${arrowMatch[1]} = (...) =>`;
    }
    return null;
  }

  /**
   * Extract imports
   */
  _extractImports(rootNode, code, language) {
    const imports = [];
    const stack = [rootNode];
    
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.type === 'import_statement' || node.type === 'import_declaration') {
        const sourceNode = node.children?.find(c => c.type === 'string');
        if (sourceNode) {
          imports.push(sourceNode.text.replace(/['"]/g, ''));
        }
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
    
    return imports;
  }

  /**
   * Extract docstrings
   */
  _extractDocstrings(rootNode, chunk, language) {
    const docstrings = [];
    
    if (language === 'python') {
      const stack = [rootNode];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === 'string' && this._isDocstring(node, rootNode)) {
          docstrings.push(node.text);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    } else if (language === 'javascript' || language === 'typescript') {
      const stack = [rootNode];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === 'comment' && node.text.startsWith('*')) {
          docstrings.push(node.text);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }

    return docstrings;
  }

  _isDocstring(node, rootNode) {
    const parent = node.parent;
    return parent?.type === 'function_definition' || 
           parent?.type === 'class_definition';
  }

  /**
   * Calculate NWS density
   */
  _calculateNWS(text) {
    const total = text.length;
    const whitespace = (text.match(/\s/g) || []).length;
    return (total - whitespace) / total;
  }

  /**
   * Count AST nodes in chunk
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
   * Enrich batch of chunks
   */
  enrichChunks(chunks, code, language) {
    return chunks.map(chunk => this.enrichChunk(chunk, code, language));
  }
}

// Singleton
let enricher = null;
export function getEnricher() {
  if (!enricher) {
    enricher = new MetadataEnricher();
  }
  return enricher;
}
```

---

## Code Chunking vs Text Chunking Comparison

### Example: JavaScript Function

**Input Code:**
```javascript
function getUser(id) {
  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}
```

**Text-Based Chunking (1500 chars):**
```
"function getUser(id) {\n  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);\n  if (!user) {\n    throw new Error('User not found');\n  }\n  return user;\n}\n\nfunction updateUser(id, data) {\n  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);\n  if (!user) {\n    throw new Error('User not found');\n  }\n  return db.update('users', data, { id });\n}\n\nfunction deleteUser(id) {\n  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);\n  if (!user) {\n    throw new Error('User not found');\n  }\n  return db.delete('users', { id });\n}"
```
❌ Problem: Cuts in middle of function, loses context

**AST-Aware Chunking:**
```
"function getUser(id) {\n  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);\n  if (!user) {\n    throw new Error('User not found');\n  }\n  return user;\n}"

Metadata:
- scopeChain: "UserService > getUser"
- signature: "function getUser(id)"
- imports: ["db", "Error"]
- docstrings: []
- nwsDensity: 0.68
```
✅ Solution: Preserves complete function with context

---

## Testing Strategy

### Unit Tests

```javascript
// tests/chunking/ast.test.js
import { describe, it, expect } from 'node:test';

describe('ASTParser', () => {
  it('parses JavaScript code', async () => {
    const parser = getASTParser();
    await parser.initialize();
    
    const ast = parser.parse('function test() { return 1; }', 'javascript');
    expect(ast.type).toBe('program');
  });

  it('extracts functions from AST', () => {
    const parser = getASTParser();
    const ast = parser.parse('function foo() {} function bar() {}', 'javascript');
    const functions = parser.getFunctions(ast, 'javascript');
    
    expect(functions).toHaveLength(2);
    expect(functions[0].name).toBe('foo');
  });
});

describe('ScopeChainBuilder', () => {
  it('builds scope chain for class method', () => {
    const builder = getScopeChainBuilder();
    const code = `class UserService { getUser() { return 1; } }`;
    const ast = parser.parse(code, 'javascript');
    const scopes = builder.buildAllScopes(ast, 'javascript');
    
    expect(scopes[0].scopeChain).toBe('class:UserService > method:getUser');
  });
});

describe('NWSDensityCalculator', () => {
  it('calculates density correctly', () => {
    const calculator = getNWSCalculator();
    const result = calculator.calculateDensity('function test() { return 1; }');
    
    expect(result.density).toBeGreaterThan(0.3);
    expect(result.nonWhitespaceChars).toBeGreaterThan(0);
  });
});

describe('SyntaxChunker', () => {
  it('chunks JavaScript code with AST awareness', () => {
    const chunker = getSyntaxChunker();
    const code = `function foo() { return 1; }\nfunction bar() { return 2; }`;
    const chunks = chunker.chunk(code, 'javascript');
    
    expect(chunks).toHaveLength(2);
    expect(chunks[0].scopeChain).not.toBe('global');
  });
});
```

### Integration Tests

```javascript
// tests/integration/chunking.test.js
import { describe, it, expect } from 'node:test';

describe('AST-Aware Chunking Integration', () => {
  it('end-to-end code chunking pipeline', async () => {
    const chunker = getSyntaxChunker();
    const code = fs.readFileSync('test/fixtures/user-service.js');
    
    const chunks = chunker.chunk(code, 'javascript');
    
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toHaveProperty('scopeChain');
    expect(chunks[0]).toHaveProperty('signature');
    expect(chunks[0]).toHaveProperty('imports');
    expect(chunks[0]).toHaveProperty('nwsDensity');
  });

  it('compares AST vs text chunking', () => {
    const chunker = getSyntaxChunker();
    const code = fs.readFileSync('test/fixtures/large-file.js');
    
    const comparison = chunker.compareStrategies(code, 'javascript');
    
    // AST chunking should have better scope coverage
    expect(comparison.ast.scopeCoverage).toBeGreaterThan(comparison.text.scopeCoverage);
    
    // AST chunking should have better density
    expect(comparison.ast.avgDensity).toBeGreaterThan(comparison.text.avgDensity);
  });
});
```

---

## Dependencies

| Component | Dependency | Priority |
|-----------|-----------|----------|
| Tree-sitter | `web-tree-sitter` | P0 |
| Parser Packages | `tree-sitter-javascript`, etc. | P0 |
| AST Parser | `core/src/chunking/tree-sitter.js` | P0 |
| Scope Builder | `core/src/chunking/scope-chain.js` | P0 |
| NWS Calculator | `core/src/chunking/nws-density.js` | P0 |
| Syntax Chunker | `core/src/chunking/syntax-chunker.js` | P0 |

---

## Estimated Effort

| Task | Hours | Days |
|------|-------|------|
| Tree-sitter Integration | 16 | 2 |
| Scope Chain Construction | 12 | 1.5 |
| NWS Density Calculation | 8 | 1 |
| Syntax-Aware Chunking | 16 | 2 |
| Metadata Enrichment | 8 | 1 |
| Testing | 12 | 1.5 |
| Documentation | 4 | 0.5 |
| **Total** | **76** | **9.5** |

---

## Success Criteria

- [ ] AST chunks preserve ≥95% of function完整性
- [ ] Scope chain coverage ≥80% for code files
- [ ] NWS density ≥0.4 for all chunks
- [ ] Chunking latency <100ms for 1000-line files
- [ ] All tests passing (unit + integration)

---

## Rollout Plan

### Phase 1: Parser Foundation (Week 1)
- Tree-sitter integration
- Basic AST traversal
- Language support matrix

### Phase 2: Scope & Density (Week 2)
- Scope chain construction
- NWS density calculation
- Chunk quality metrics

### Phase 3: Syntax-Aware Chunking (Week 3)
- Greedy window algorithm
- AST-aware merging
- Metadata enrichment

### Phase 4: Testing & Optimization (Week 4)
- Performance benchmarking
- Quality validation
- Production deployment

---

## Monitoring & Observability

### Key Metrics

| Metric | Alert Threshold | Target |
|--------|----------------|--------|
| Chunking Latency | >200ms | <100ms |
| Scope Coverage | <70% | >80% |
| Avg NWS Density | <0.3 | >0.4 |
| Chunk Completeness | <90% | >95% |

### Logging

```javascript
logger.info('chunking.process', {
  language,
  chunkCount: chunks.length,
  avgSize: stats.avgSize,
  avgDensity: stats.avgDensity,
  scopeCoverage: stats.scopeCoverage,
  latencyMs: performance.now() - start
});
```

---

## Future Enhancements

1. **Language Detection**: Auto-detect language from file content
2. **Multi-file Parsing**: Parse imports across files
3. **Call Graph Analysis**: Track function calls between chunks
4. **Type Inference**: Extract type information for TypeScript
5. **AST Diffing**: Track changes between versions

---

## References

- Tree-sitter Documentation: https://tree-sitter.github.io/tree-sitter/
- Supermemory Code Chunk: https://github.com/supermemoryai/code-chunk
- AST-based Code Analysis: https://arxiv.org/abs/2305.14701
