/**
 * Scope Chain Construction
 * Builds hierarchical path: File > Class > Method > Block
 */

import { getASTParser } from './parser.js';

/**
 * Scope Chain Builder class for constructing scope chains from AST nodes
 */
export class ScopeChainBuilder {
  constructor() {
    this.astParser = getASTParser();
  }

  /**
   * Build scope chain for a node
   * @param {Object} rootNode - AST root node
   * @param {Object} targetNode - Target node to find scope for
   * @param {string} language - Language identifier
   * @returns {Array} Scope chain array
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
   * @param {Object} node - AST node
   * @param {string} language - Language identifier
   * @returns {Object|null} Scope info object or null
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
      method_definition: { type: 'method', name: this._getName(node) },
      block: { type: 'block', name: 'block' },
      statement_block: { type: 'block', name: 'block' }
    };

    return scopeMap[type] || null;
  }

  /**
   * Extract name from node
   * @param {Object} node - AST node
   * @returns {string} Name string or 'anonymous'
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
   * @param {Array} chain - Scope chain array
   * @returns {string} Formatted scope chain string
   */
  formatScopeChain(chain) {
    return chain.map(item => `${item.type}:${item.name}`).join(' > ');
  }

  /**
   * Build scope chain for all functions in file
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of scope objects
   */
  buildAllScopes(rootNode, language) {
    const scopes = [];
    const functions = this.astParser.getFunctions(rootNode, language);
    const classes = this.astParser.getClasses(rootNode, language);
    const methods = this.astParser.getMethods(rootNode, language);

    // Build scope for each function
    for (const func of functions) {
      const chain = this.buildScopeChain(rootNode, func.body, language);
      scopes.push({
        type: 'function',
        name: func.name,
        scopeChain: this.formatScopeChain(chain),
        start: func.start,
        end: func.end,
        body: func.body
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
        end: cls.end,
        body: cls.body
      });
    }

    // Build scope for each method
    for (const method of methods) {
      const chain = this.buildScopeChain(rootNode, method.body, language);
      scopes.push({
        type: 'method',
        name: method.name,
        scopeChain: this.formatScopeChain(chain),
        start: method.start,
        end: method.end,
        body: method.body
      });
    }

    return scopes;
  }

  /**
   * Find scope for a specific position
   * @param {Object} rootNode - AST root node
   * @param {Object} position - Position object with row/line and column
   * @param {string} language - Language identifier
   * @returns {Object|null} Scope object or null
   */
  findScopeForPosition(rootNode, position, language) {
    const scopes = this.buildAllScopes(rootNode, language);

    // Handle both 'row' (Tree-sitter) and 'line' (common) properties
    const line = position.row !== undefined ? position.row : position.line;

    return scopes.find(scope =>
      line >= scope.start.row &&
      line <= scope.end.row &&
      position.column >= scope.start.column &&
      position.column <= scope.end.column
    );
  }

  /**
   * Get scope chain for a specific chunk
   * @param {Object} rootNode - AST root node
   * @param {Object} chunk - Chunk object with start position
   * @param {string} language - Language identifier
   * @returns {string} Formatted scope chain string
   */
  getScopeForChunk(rootNode, chunk, language) {
    const scopes = this.buildAllScopes(rootNode, language);
    const chunkStart = chunk.start || 0;

    // Find the deepest scope that contains this chunk
    const matchingScope = scopes.find(scope =>
      chunkStart >= (scope.start?.character || 0) &&
      chunkStart <= (scope.end?.character || Infinity)
    );

    return matchingScope ? matchingScope.scopeChain : 'global';
  }

  /**
   * Build scope chain from text content
   * @param {string} code - Source code
   * @param {string} language - Language identifier
   * @returns {Object} Object with scopes and scopeChain
   */
  buildFromText(code, language) {
    const rootNode = this.astParser.parse(code, language);
    const scopes = this.buildAllScopes(rootNode, language);

    return {
      scopes,
      scopeChain: scopes.length > 0 ? scopes[0].scopeChain : 'global',
      rootNode
    };
  }

  /**
   * Get scope hierarchy for a function
   * @param {Object} rootNode - AST root node
   * @param {string} functionName - Function name
   * @param {string} language - Language identifier
   * @returns {Array|null} Scope hierarchy array or null
   */
  getFunctionScope(rootNode, functionName, language) {
    const scopes = this.buildAllScopes(rootNode, language);
    return scopes.find(s => s.name === functionName && s.type === 'function');
  }

  /**
   * Get scope hierarchy for a method
   * @param {Object} rootNode - AST root node
   * @param {string} methodName - Method name
   * @param {string} language - Language identifier
   * @returns {Array|null} Scope hierarchy array or null
   */
  getMethodScope(rootNode, methodName, language) {
    const scopes = this.buildAllScopes(rootNode, language);
    return scopes.find(s => s.name === methodName && s.type === 'method');
  }

  /**
   * Get scope hierarchy for a class
   * @param {Object} rootNode - AST root node
   * @param {string} className - Class name
   * @param {string} language - Language identifier
   * @returns {Array|null} Scope hierarchy array or null
   */
  getClassScope(rootNode, className, language) {
    const scopes = this.buildAllScopes(rootNode, language);
    return scopes.find(s => s.name === className && s.type === 'class');
  }
}

// Singleton instance
let scopeChainBuilder = null;

/**
 * Get singleton ScopeChainBuilder instance
 * @returns {ScopeChainBuilder} Scope chain builder instance
 */
export function getScopeChainBuilder() {
  if (!scopeChainBuilder) {
    scopeChainBuilder = new ScopeChainBuilder();
  }
  return scopeChainBuilder;
}
