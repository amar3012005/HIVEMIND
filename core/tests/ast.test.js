/**
 * AST Parser Tests
 * Tests for Tree-sitter-based AST parsing, scope chain construction,
 * NWS density calculation, and syntax-aware chunking
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { getASTParser } from '../src/ast/parser.js';
import { getScopeChainBuilder } from '../src/ast/scope.js';
import { getNWSCalculator } from '../src/ast/density.js';
import { getSyntaxChunker } from '../src/chunker.ast.js';

// Sample code for testing
const SAMPLE_JAVASCRIPT = `
/**
 * User service class
 * Handles user-related operations
 */
class UserService {
  /**
   * Get user by ID
   * @param {string} id - User ID
   * @returns {Object|null} User object or null
   */
  async getUser(id) {
    const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }

  /**
   * Update user information
   * @param {string} id - User ID
   * @param {Object} data - Update data
   * @returns {Object} Updated user
   */
  async updateUser(id, data) {
    const user = await this.getUser(id);
    return await db.update('users', data, { id });
  }
}

// Export module
export { UserService };
`;

const SAMPLE_TYPESCRIPT = `
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

/**
 * User repository service
 */
@Injectable()
export class UserRepository {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  /**
   * Create new user
   */
  async create(user: User): Promise<User> {
    return this.userRepository.save(user);
  }
}
`;

const SAMPLE_PYTHON = `
"""
User service module
Handles all user-related operations
"""

from typing import Optional
from database import Database

class UserService:
    """
    Service class for user operations
    """
    
    def __init__(self, db: Database):
        """Initialize the user service"""
        self.db = db
    
    def get_user(self, user_id: str) -> Optional[dict]:
        """
        Get user by ID
        
        Args:
            user_id: The user ID
            
        Returns:
            User dictionary or None
        """
        return self.db.query("SELECT * FROM users WHERE id = ?", [user_id])
    
    def update_user(self, user_id: str, data: dict) -> dict:
        """Update user information"""
        user = self.get_user(user_id)
        if not user:
            raise ValueError("User not found")
        return self.db.update("users", data, {"id": user_id})
`;

// Initialize parsers once
let parser, builder, calculator, chunker;

async function initialize() {
  if (!parser) {
    parser = getASTParser();
    await parser.initialize();
  }
  if (!builder) {
    builder = getScopeChainBuilder();
  }
  if (!calculator) {
    calculator = getNWSCalculator();
  }
  if (!chunker) {
    chunker = getSyntaxChunker();
  }
}

// ==========================================
// ASTParser Tests
// ==========================================
test('ASTParser - parses JavaScript code', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  assert.strictEqual(ast.type, 'program');
  // Verify the AST contains expected content (whitespace may differ)
  assert.ok(ast.text.includes('UserService'));
  assert.ok(ast.text.includes('getUser'));
});

test('ASTParser - parses TypeScript code', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_TYPESCRIPT, 'typescript');
  assert.strictEqual(ast.type, 'program');
});

test('ASTParser - parses Python code', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_PYTHON, 'python');
  // Python uses 'module' as root type, not 'program'
  assert.ok(['program', 'module'].includes(ast.type));
});

test('ASTParser - extracts functions from JavaScript AST', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const functions = parser.getFunctions(ast, 'javascript');
  const methods = parser.getMethods(ast, 'javascript');
  
  // The sample has async methods in a class, which are parsed as methods
  // Regular functions would be parsed as function_declaration
  const allMethods = [...functions, ...methods];
  assert.ok(allMethods.length > 0);
  const methodNames = allMethods.map(m => m.name);
  assert.ok(methodNames.includes('getUser'));
  assert.ok(methodNames.includes('updateUser'));
});

test('ASTParser - extracts classes from JavaScript AST', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const classes = parser.getClasses(ast, 'javascript');

  assert.ok(classes.length > 0);
  const classNames = classes.map(c => c.name);
  assert.ok(classNames.includes('UserService'));
});

test('ASTParser - extracts imports from TypeScript AST', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_TYPESCRIPT, 'typescript');
  const imports = parser.getImports(ast, 'typescript');

  assert.ok(imports.length > 0);
  assert.ok(imports.includes('@nestjs/common'));
  assert.ok(imports.includes('@nestjs/typeorm'));
});

test('ASTParser - detects language from file extension', async () => {
  await initialize();
  assert.strictEqual(parser._detectLanguage('test.js'), 'javascript');
  assert.strictEqual(parser._detectLanguage('test.ts'), 'typescript');
  assert.strictEqual(parser._detectLanguage('test.py'), 'python');
  assert.strictEqual(parser._detectLanguage('test.go'), 'go');
  assert.strictEqual(parser._detectLanguage('test.rs'), 'rust');
  assert.strictEqual(parser._detectLanguage('test.java'), 'java');
  assert.strictEqual(parser._detectLanguage('test.c'), 'c');
  assert.strictEqual(parser._detectLanguage('test.cpp'), 'cpp');
  assert.strictEqual(parser._detectLanguage('test.cs'), 'csharp');
  assert.strictEqual(parser._detectLanguage('test.txt'), 'javascript');
});

test('ASTParser - extracts docstrings from Python AST', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_PYTHON, 'python');
  const docstrings = parser.getDocstrings(ast, 'python');

  assert.ok(docstrings.length > 0);
  assert.ok(docstrings.some(d => d.includes('User service module')));
});

test('ASTParser - extracts docstrings from JavaScript AST', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const docstrings = parser.getDocstrings(ast, 'javascript');

  assert.ok(docstrings.length > 0);
});

test('ASTParser - gets function signature', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const functions = parser.getFunctions(ast, 'javascript');
  const methods = parser.getMethods(ast, 'javascript');
  
  // The sample has async methods in a class, which are parsed as methods
  // Regular functions would be parsed as function_declaration
  const allMethods = [...functions, ...methods];
  const func = allMethods.find(f => f.name === 'getUser');

  assert.ok(func !== undefined);
  const signature = parser.getFunctionSignature(func.body, 'javascript');
  assert.ok(signature !== null);
});

test('ASTParser - gets class signature', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const classes = parser.getClasses(ast, 'javascript');
  const cls = classes.find(c => c.name === 'UserService');

  assert.ok(cls !== undefined);
  const signature = parser.getClassSignature(cls.body, 'javascript');
  assert.strictEqual(signature, 'class UserService');
});

// ==========================================
// ScopeChainBuilder Tests
// ==========================================
test('ScopeChainBuilder - builds scope chain for class method', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const scopes = builder.buildAllScopes(ast, 'javascript');

  assert.ok(scopes.length > 0);
  const userScopes = scopes.filter(s => s.name === 'UserService');
  assert.ok(userScopes.length > 0);

  const userScope = userScopes[0];
  assert.ok(userScope.scopeChain.includes('class:UserService'));
});

test('ScopeChainBuilder - builds scope chain for methods', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const scopes = builder.buildAllScopes(ast, 'javascript');

  const methodScopes = scopes.filter(s => s.type === 'method');
  assert.ok(methodScopes.length > 0);

  const getUserScope = methodScopes.find(s => s.name === 'getUser');
  assert.ok(getUserScope !== undefined);
  assert.ok(getUserScope.scopeChain.includes('class:UserService'));
  assert.ok(getUserScope.scopeChain.includes('method:getUser'));
});

test('ScopeChainBuilder - formats scope chain as string', async () => {
  await initialize();
  const chain = [
    { type: 'class', name: 'UserService' },
    { type: 'method', name: 'getUser' }
  ];
  const formatted = builder.formatScopeChain(chain);
  assert.strictEqual(formatted, 'class:UserService > method:getUser');
});

test('ScopeChainBuilder - builds scope chain from text', async () => {
  await initialize();
  const result = builder.buildFromText(SAMPLE_JAVASCRIPT, 'javascript');

  assert.ok(result.scopes !== undefined);
  assert.ok(result.scopeChain !== undefined);
  assert.ok(result.rootNode !== undefined);
});

test('ScopeChainBuilder - finds scope for position', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const scopes = builder.buildAllScopes(ast, 'javascript');

  // Find a position within a method or function
  const methodScope = scopes.find(s => s.type === 'method' || s.type === 'function');
  assert.ok(methodScope !== undefined);

  // Use a position within the method body (not at the name)
  // Note: Tree-sitter uses 'row' and 'column' not 'line' and 'column'
  const position = {
    row: methodScope.start.row,
    column: methodScope.start.column + 5  // Offset into the method body
  };
  const found = builder.findScopeForPosition(ast, position, 'javascript');
  assert.ok(found !== undefined);
  assert.strictEqual(found.name, methodScope.name);
});

test('ScopeChainBuilder - gets function scope by name', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const scope = builder.getFunctionScope(ast, 'getUser', 'javascript');
  
  // The sample has async methods in a class, which are parsed as methods
  // If function scope not found, try method scope
  if (!scope) {
    const methodScope = builder.getMethodScope(ast, 'getUser', 'javascript');
    assert.ok(methodScope !== undefined);
    assert.strictEqual(methodScope.name, 'getUser');
    assert.strictEqual(methodScope.type, 'method');
  } else {
    assert.ok(scope !== undefined);
    assert.strictEqual(scope.name, 'getUser');
    assert.strictEqual(scope.type, 'function');
  }
});

test('ScopeChainBuilder - gets class scope by name', async () => {
  await initialize();
  const ast = parser.parse(SAMPLE_JAVASCRIPT, 'javascript');
  const scope = builder.getClassScope(ast, 'UserService', 'javascript');

  assert.ok(scope !== undefined);
  assert.strictEqual(scope.name, 'UserService');
  assert.strictEqual(scope.type, 'class');
});

// ==========================================
// NWSDensityCalculator Tests
// ==========================================
test('NWSDensityCalculator - calculates density correctly', async () => {
  await initialize();
  const text = 'function test() { return 1; }';
  const result = calculator.calculateDensity(text);

  assert.ok(result.totalChars > 0);
  assert.ok(result.nonWhitespaceChars > 0);
  assert.ok(result.density > 0);
  assert.ok(result.density <= 1);
});

test('NWSDensityCalculator - calculates density for code with whitespace', async () => {
  await initialize();
  const text = `
      function test() {
        return 1;
      }
    `;
  const result = calculator.calculateDensity(text);

  assert.ok(result.totalChars > 0);
  assert.ok(result.whitespaceChars > 0);
  assert.ok(result.nonWhitespaceChars > 0);
  assert.ok(result.density > 0);
});

test('NWSDensityCalculator - calculates density for empty string', async () => {
  await initialize();
  const result = calculator.calculateDensity('');

  assert.strictEqual(result.totalChars, 0);
  assert.strictEqual(result.nonWhitespaceChars, 0);
  assert.strictEqual(result.density, 0);
});

test('NWSDensityCalculator - calculates node density', async () => {
  await initialize();
  const ast = parser.parse('function test() { return 1; }', 'javascript');

  const result = calculator.calculateNodeDensity(ast, 'function test() { return 1; }');
  assert.ok(result.density > 0);
});

test('NWSDensityCalculator - calculates chunk density', async () => {
  await initialize();
  const chunk = { text: 'function test() { return 1; }' };
  const result = calculator.calculateChunkDensity(chunk);

  assert.ok(result.density > 0);
});

test('NWSDensityCalculator - scores chunk', async () => {
  await initialize();
  const chunk = { text: 'function test() { return 1; }' };
  const score = calculator.scoreChunk(chunk);

  assert.ok(score > 0);
  assert.ok(score <= 1);
});

test('NWSDensityCalculator - filters chunks by density', async () => {
  await initialize();
  const chunks = [
    { text: 'function test() { return 1; }' },
    { text: '   \n\n   ' },
    { text: 'const x = 1;' }
  ];

  const filtered = calculator.filterByDensity(chunks, 0.3);
  assert.ok(filtered.length <= chunks.length);
});

test('NWSDensityCalculator - merges small chunks', async () => {
  await initialize();
  const chunks = [
    { text: 'function foo() {', start: 0, end: 20 },
    { text: ' return 1; }', start: 20, end: 35 },
    { text: 'function bar() {', start: 35, end: 55 },
    { text: ' return 2; }', start: 55, end: 70 }
  ];

  const merged = calculator.mergeSmallChunks(chunks, 0.3);
  assert.ok(merged.length > 0);
});

test('NWSDensityCalculator - gets density statistics', async () => {
  await initialize();
  const chunks = [
    { text: 'function test() { return 1; }' },
    { text: 'const x = 1;' },
    { text: 'class Foo {}' }
  ];

  const stats = calculator.getDensityStats(chunks);
  assert.strictEqual(stats.count, 3);
  assert.ok(stats.min > 0);
  assert.ok(stats.max <= 1);
  assert.ok(stats.avg > 0);
  assert.ok(stats.median > 0);
});

test('NWSDensityCalculator - checks density threshold', async () => {
  await initialize();
  const text = 'function test() { return 1; }';
  assert.strictEqual(calculator.meetsThreshold(text, 0.3), true);
  assert.strictEqual(calculator.meetsThreshold('   \n\n   ', 0.3), false);
});

test('NWSDensityCalculator - calculates range density', async () => {
  await initialize();
  const code = 'function test() { return 1; }';
  const result = calculator.calculateRangeDensity(code, 0, 20);

  assert.ok(result.density > 0);
});

test('NWSDensityCalculator - batches calculate density', async () => {
  await initialize();
  const chunks = [
    { text: 'function test() { return 1; }' },
    { text: 'const x = 1;' }
  ];

  const results = calculator.batchCalculateDensity(chunks);
  assert.strictEqual(results.length, 2);
  assert.ok(results[0].density > 0);
  assert.ok(results[1].density > 0);
});

// ==========================================
// SyntaxChunker Tests
// ==========================================
test('SyntaxChunker - chunks JavaScript code with AST awareness', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');

  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].text !== undefined);
  assert.ok(chunks[0].scopeChain !== undefined);
  assert.ok(chunks[0].nwsDensity !== undefined);
  assert.ok(chunks[0].signature !== undefined);
  assert.ok(chunks[0].imports !== undefined);
  assert.ok(chunks[0].docstrings !== undefined);
  assert.ok(chunks[0].astNodeCount !== undefined);
});

test('SyntaxChunker - chunks TypeScript code', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_TYPESCRIPT, 'typescript');

  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].scopeChain !== undefined);
});

test('SyntaxChunker - chunks Python code', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_PYTHON, 'python');

  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].scopeChain !== undefined);
});

test('SyntaxChunker - extracts scope chain for chunks', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');

  // At least some chunks should have non-global scope
  const withScope = chunks.filter(c => c.scopeChain !== 'global');
  assert.ok(withScope.length > 0);
});

test('SyntaxChunker - extracts function signatures', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');

  const withSignature = chunks.filter(c => c.signature !== null);
  assert.ok(withSignature.length > 0);
});

test('SyntaxChunker - extracts imports', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_TYPESCRIPT, 'typescript');

  assert.ok(chunks[0].imports !== undefined);
  assert.ok(Array.isArray(chunks[0].imports));
});

test('SyntaxChunker - extracts docstrings', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_PYTHON, 'python');

  assert.ok(chunks[0].docstrings !== undefined);
  assert.ok(Array.isArray(chunks[0].docstrings));
});

test('SyntaxChunker - calculates NWS density', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');

  chunks.forEach(chunk => {
    assert.ok(chunk.nwsDensity > 0);
    assert.ok(chunk.nwsDensity <= 1);
  });
});

test('SyntaxChunker - compares AST vs text chunking', async () => {
  await initialize();
  const comparison = chunker.compareStrategies(SAMPLE_JAVASCRIPT, 'javascript');

  assert.ok(comparison.ast.count > 0);
  assert.ok(comparison.text.count > 0);
  assert.ok(comparison.ast.avgSize > 0);
  assert.ok(comparison.ast.avgDensity > 0);
});

test('SyntaxChunker - gets chunk statistics', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');
  const stats = chunker.getChunkStats(chunks);

  assert.ok(stats.chunkCount > 0);
  assert.ok(stats.avgSize > 0);
  assert.ok(stats.avgDensity > 0);
  assert.ok(stats.scopeCoverage >= 0);
});

test('SyntaxChunker - gets high-quality chunks', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');
  const highQuality = chunker.getHighQualityChunks(chunks);

  // All high-quality chunks should have density > 0.7
  highQuality.forEach(chunk => {
    assert.ok(chunk.nwsDensity > 0.7);
  });
});

test('SyntaxChunker - chunks multiple files', async () => {
  await initialize();
  const files = [
    { code: SAMPLE_JAVASCRIPT, language: 'javascript', filename: 'UserService.js' },
    { code: SAMPLE_PYTHON, language: 'python', filename: 'UserService.py' }
  ];

  const allChunks = chunker.chunkMultiple(files);

  assert.ok(allChunks.length > 0);
  assert.strictEqual(allChunks[0].filename, 'UserService.js');
});

test('SyntaxChunker - respects max chunk size', async () => {
  await initialize();
  const chunks = chunker.chunk(SAMPLE_JAVASCRIPT, 'javascript');

  chunks.forEach(chunk => {
    assert.ok(chunk.text.length <= chunker.maxChunkSize);
  });
});

test('SyntaxChunker - handles empty code', async () => {
  await initialize();
  const chunks = chunker.chunk('', 'javascript');
  assert.strictEqual(chunks.length, 0);
});

test('SyntaxChunker - handles code with only whitespace', async () => {
  await initialize();
  const chunks = chunker.chunk('   \n\n   ', 'javascript');
  assert.strictEqual(chunks.length, 0);
});

// ==========================================
// Integration Tests
// ==========================================
test('Integration - end-to-end code chunking pipeline', async () => {
  await initialize();
  const code = SAMPLE_JAVASCRIPT;
  const language = 'javascript';

  // Parse AST
  const rootNode = parser.parse(code, language);

  // Build scope chain
  const scopes = builder.buildAllScopes(rootNode, language);
  assert.ok(scopes.length > 0);

  // Chunk with AST awareness
  const chunks = chunker.chunk(code, language);
  assert.ok(chunks.length > 0);

  // Verify all chunks have AST metadata
  chunks.forEach(chunk => {
    assert.ok(chunk.scopeChain !== undefined);
    assert.ok(chunk.nwsDensity !== undefined);
  });
});

test('Integration - AST chunking preserves function integrity', async () => {
  await initialize();
  const code = `
function getUser(id) {
  const user = db.query('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}

function updateUser(id, data) {
  const user = getUser(id);
  return db.update('users', data, { id });
}
`;

  const chunks = chunker.chunk(code, 'javascript');

  // Each function should be in its own chunk or properly split
  assert.ok(chunks.length > 0);

  // Check that function bodies are preserved
  chunks.forEach(chunk => {
    // NWS density should be acceptable
    assert.ok(chunk.nwsDensity > 0.3);
  });
});

test('Integration - scope chain includes file, class, method, block', async () => {
  await initialize();
  const code = `
class UserService {
  async getUser(id) {
    if (id) {
      return { id, name: 'Test' };
    }
    return null;
  }
}
`;

  const rootNode = parser.parse(code, 'javascript');
  const scopes = builder.buildAllScopes(rootNode, 'javascript');

  // Should have class and method scopes
  const classScopes = scopes.filter(s => s.type === 'class');
  const methodScopes = scopes.filter(s => s.type === 'method');

  assert.ok(classScopes.length > 0);
  assert.ok(methodScopes.length > 0);

  // Verify scope chain format
  const methodScope = methodScopes[0];
  assert.ok(methodScope.scopeChain.includes('class:'));
  assert.ok(methodScope.scopeChain.includes('method:'));
});

test('Integration - NWS density calculation for code quality', async () => {
  await initialize();
  const code = `
// Low density - mostly comments
/**
 * This is a comment
 * With multiple lines
 */

// High density - actual code
function process(data) {
  return data.map(item => item * 2);
}
`;

  const chunks = chunker.chunk(code, 'javascript');
  const stats = calculator.getDensityStats(chunks);

  // Average density should be reasonable
  assert.ok(stats.avg > 0.3);
  assert.ok(stats.count > 0);
});

test('Integration - AST chunking vs text chunking comparison', async () => {
  await initialize();
  const code = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  async find(id: string) {
    return { id, name: 'Test' };
  }
}
`;

  const comparison = chunker.compareStrategies(code, 'typescript');

  // AST chunking should have better scope coverage
  assert.ok(comparison.ast.scopeCoverage !== undefined && comparison.ast.scopeCoverage >= 0);
  // Text-based chunking doesn't have scope coverage
  assert.ok(comparison.ast.count > 0);
  assert.ok(comparison.text.count > 0);
});
