/**
 * Tree-sitter AST Parser for Technical Intelligence
 * Supports JavaScript, TypeScript, Python, Go, Rust, Java, C#
 */

import Parser from 'tree-sitter';
import { readFileSync } from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

/**
 * AST Parser class for parsing source code and extracting AST information
 */
export class ASTParser {
  constructor() {
    this.parsers = new Map();
    this.initialized = false;
    this._initializeSync();
  }

  /**
   * Initialize Tree-sitter parsers
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;

    this.initialized = true;

    // Load parsers dynamically
    for (const [lang, config] of Object.entries(LANGUAGES)) {
      try {
        // Import the parser module
        const parserModule = await import(config.parser);
        
        // Get the language object - handle different export patterns
        let language;
        
        // For TypeScript parser, default has typescript/tsx sub-objects
        if (lang === 'typescript' && parserModule.default) {
          language = parserModule.default.typescript || parserModule.default.tsx;
        } else if (parserModule.default) {
          // Check if default is a language object (has language property)
          if (parserModule.default.language) {
            language = parserModule.default;
          } else {
            // For parsers that export language directly as default
            language = parserModule.default;
          }
        } else if (parserModule.typescript && parserModule.typescript.language) {
          language = parserModule.typescript;
        } else if (parserModule.tsx && parserModule.tsx.language) {
          language = parserModule.tsx;
        } else if (parserModule[lang] && parserModule[lang].language) {
          language = parserModule[lang];
        } else {
          throw new Error('No language object found in parser module');
        }
        
        const parser = new Parser();
        parser.setLanguage(language);
        this.parsers.set(lang, parser);
      } catch (error) {
        console.warn(`Failed to load parser for ${lang}:`, error.message);
      }
    }
  }

  _initializeSync() {
    if (this.initialized) return;

    for (const [lang, config] of Object.entries(LANGUAGES)) {
      try {
        const parserModule = require(config.parser);
        let language;

        if (lang === 'typescript' && parserModule.typescript) {
          language = parserModule.typescript;
        } else if (parserModule.language) {
          language = parserModule;
        } else if (parserModule.default?.language) {
          language = parserModule.default;
        } else if (parserModule.default?.typescript) {
          language = parserModule.default.typescript;
        } else if (parserModule.default) {
          language = parserModule.default;
        } else {
          continue;
        }

        const parser = new Parser();
        parser.setLanguage(language);
        this.parsers.set(lang, parser);
      } catch (error) {
        // Ignore missing parser packages in local environments.
      }
    }

    this.initialized = this.parsers.size > 0;
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
   * @param {string} filePath - File path
   * @returns {string} Language identifier
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
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of function objects
   */
  getFunctions(rootNode, language) {
    const functions = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      const funcTypes = [
        'function_declaration',
        'function_definition',
        'function_item',
        'function_expression',
        'generator_function',
        'generator_function_declaration'
      ];

      if (funcTypes.includes(node.type)) {
        const nameNode = this._findNameNode(node, language);
        if (nameNode) {
          functions.push({
            name: nameNode.text,
            start: nameNode.startPosition,
            end: nameNode.endPosition,
            body: node
          });
        }
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return functions;
  }

  /**
   * Get all class definitions in AST
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of class objects
   */
  getClasses(rootNode, language) {
    const classes = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      const classTypes = [
        'class_declaration',
        'class_definition',
        'struct_item',
        'class'
      ];

      if (classTypes.includes(node.type)) {
        const nameNode = this._findNameNode(node, language);
        if (nameNode) {
          classes.push({
            name: nameNode.text,
            start: nameNode.startPosition,
            end: nameNode.endPosition,
            body: node
          });
        }
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return classes;
  }

  /**
   * Get all method definitions in AST
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of method objects
   */
  getMethods(rootNode, language) {
    const methods = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      const methodTypes = [
        'method_definition',
        'method_declaration',
        'method'
      ];

      if (methodTypes.includes(node.type)) {
        const nameNode = this._findNameNode(node, language);
        if (nameNode) {
          methods.push({
            name: nameNode.text,
            start: nameNode.startPosition,
            end: nameNode.endPosition,
            body: node
          });
        }
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return methods;
  }

  /**
   * Find name node in a function/class/method node
   * @param {Object} node - AST node
   * @param {string} language - Language identifier
   * @returns {Object|null} Name node or null
   */
  _findNameNode(node, language) {
    // Try to find identifier child
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'property_identifier' || 
          child.type === 'type_identifier' || child.type === 'class_name') {
        return child;
      }
    }

    // For some languages, name might be in a specific position
    if (language === 'python') {
      // Python function/class definitions have name as second child
      if (node.children.length > 1) {
        const secondChild = node.children[1];
        if (secondChild.type === 'identifier') {
          return secondChild;
        }
      }
    }

    return null;
  }

  /**
   * Get all import statements in AST
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of import source strings
   */
  getImports(rootNode, language) {
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
   * Get all variable declarations in AST
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of variable names
   */
  getVariables(rootNode, language) {
    const variables = [];
    const stack = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop();

      if (node.type === 'variable_declarator' || node.type === 'assignment_pattern') {
        const nameNode = this._findNameNode(node, language);
        if (nameNode) {
          variables.push(nameNode.text);
        }
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return variables;
  }

  /**
   * Extract docstrings/comments from AST
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of docstring/comment texts
   */
  getDocstrings(rootNode, language) {
    const docstrings = [];

    if (language === 'python') {
      // Python docstrings are string expressions at the start of functions/classes
      const stack = [rootNode];
      while (stack.length > 0) {
        const node = stack.pop();

        // Look for string nodes that are first child of expression_statement
        if (node.type === 'string') {
          const parent = node.parent;
          if (parent && parent.type === 'expression_statement') {
            // Check if this is the first child (docstring position)
            if (parent.children[0] === node) {
              docstrings.push(node.text);
            }
          }
        }

        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    } else if (language === 'javascript' || language === 'typescript') {
      // JavaScript/TypeScript docstrings are comment nodes
      const stack = [rootNode];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === 'comment') {
          docstrings.push(node.text);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }

    return docstrings;
  }

  /**
   * Get all top-level declarations in file
   * @param {Object} rootNode - AST root node
   * @param {string} language - Language identifier
   * @returns {Array} Array of declaration objects
   */
  getDeclarations(rootNode, language) {
    const declarations = [];

    // Collect all functions, classes, and top-level statements
    const stack = [rootNode];
    while (stack.length > 0) {
      const node = stack.pop();

      const declarationTypes = [
        'function_declaration',
        'class_declaration',
        'function_definition',
        'class_definition',
        'method_definition',
        'method_declaration',
        'import_statement',
        'import_declaration',
        'variable_declaration'
      ];

      if (declarationTypes.includes(node.type)) {
        declarations.push({
          type: node.type,
          text: node.text,
          start: node.startPosition,
          end: node.endPosition
        });
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }

    return declarations;
  }

  /**
   * Get function signature from function node
   * @param {Object} node - Function node
   * @param {string} language - Language identifier
   * @returns {string} Function signature string
   */
  getFunctionSignature(node, language) {
    if (language === 'javascript' || language === 'typescript') {
      const nameNode = node.children?.find(c => c.type === 'identifier');
      const paramsNode = node.children?.find(c => c.type === 'formal_parameters');

      if (nameNode && paramsNode) {
        const params = paramsNode.children
          .filter(c => c.type === 'identifier')
          .map(c => c.text)
          .join(', ');
        return `function ${nameNode.text}(${params})`;
      }
    } else if (language === 'python') {
      const nameNode = node.children?.find(c => c.type === 'identifier');
      const paramsNode = node.children?.find(c => c.type === 'parameters');

      if (nameNode && paramsNode) {
        const params = paramsNode.children
          .filter(c => c.type === 'identifier')
          .map(c => c.text)
          .join(', ');
        return `def ${nameNode.text}(${params})`;
      }
    }

    return 'anonymous';
  }

  /**
   * Get class signature from class node
   * @param {Object} node - Class node
   * @param {string} language - Language identifier
   * @returns {string} Class signature string
   */
  getClassSignature(node, language) {
    if (language === 'javascript' || language === 'typescript') {
      const nameNode = node.children?.find(c => c.type === 'identifier');
      if (nameNode) {
        return `class ${nameNode.text}`;
      }
    } else if (language === 'python') {
      const nameNode = node.children?.find(c => c.type === 'identifier');
      if (nameNode) {
        return `class ${nameNode.text}`;
      }
    }

    return 'anonymous';
  }
}

// Singleton instance
let astParser = null;

/**
 * Get singleton AST parser instance
 * @returns {ASTParser} AST parser instance
 */
export function getASTParser() {
  if (!astParser) {
    astParser = new ASTParser();
  }
  return astParser;
}
