/**
 * HIVE-MIND MCP Server with Zod Validation
 * Implements the "Supermemory" tool pattern for strict input validation
 * Ensures all memory operations follow the Normalized Memory Schema
 */

import { z } from 'zod';

// ============================================================================
// Schema Definitions (Normalized Memory Schema)
// ============================================================================

/**
 * Memory content schema - accepts text, code, or structured data
 */
export const MemoryContentSchema = z.string()
  .min(1, "Memory content cannot be empty")
  .max(50000, "Memory content exceeds maximum length of 50,000 characters")
  .describe("The text, code, or data to remember");

/**
 * Tags schema - optional array of strings for categorization
 */
export const MemoryTagsSchema = z.array(z.string())
  .max(20, "Maximum 20 tags allowed")
  .optional()
  .default([])
  .describe("Category tags for organizing memories");

/**
 * Project identifier schema - defaults to 'antigravity' for backward compatibility
 */
export const ProjectSchema = z.string()
  .min(1, "Project name cannot be empty")
  .default("antigravity")
  .describe("Project context for the memory");

/**
 * User identifier schema - UUID format preferred
 */
export const UserIdSchema = z.string()
  .uuid("Invalid UUID format")
  .describe("User who owns this memory");

/**
 * Memory priority schema - for importance ranking
 */
export const PrioritySchema = z.number()
  .min(0)
  .max(10)
  .default(5)
  .optional()
  .describe("Importance priority (0-10, default 5)");

/**
 * Relationship type for triple-operator system
 */
export const RelationshipTypeSchema = z.enum(['updates', 'extends', 'derives'])
  .optional()
  .describe("Relationship to existing memories (triple-operator system)");

/**
 * Complete memory input schema - combines all fields
 */
export const SaveMemoryInputSchema = z.object({
  content: MemoryContentSchema,
  tags: MemoryTagsSchema,
  project: ProjectSchema,
  userId: UserIdSchema.optional(),
  priority: PrioritySchema,
  relationship: z.object({
    type: RelationshipTypeSchema,
    targetId: z.string().uuid().optional()
  }).optional()
});

// ============================================================================
// Type Exports
// ============================================================================

export type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;
export type MemoryTags = z.infer<typeof MemoryTagsSchema>;
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

// ============================================================================
// Input Validation Helpers
// ============================================================================

/**
 * Validate and parse memory input with detailed error messages
 */
export function validateMemoryInput(input: unknown): {
  success: true;
  data: SaveMemoryInput
} | {
  success: false;
  error: string;
  details?: Record<string, string[]>
} {
  const result = SaveMemoryInputSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const details: Record<string, string[]> = {};
  result.error.errors.forEach(err => {
    const path = err.path.join('.') || 'root';
    if (!details[path]) details[path] = [];
    details[path].push(err.message);
  });

  return {
    success: false,
    error: result.error.message,
    details
  };
}

/**
 * Normalize memory content (trim, clean, standardize)
 */
export function normalizeMemoryContent(content: string): string {
  return content
    .trim()
    .replace(/\r\n/g, '\n')  // Normalize line endings
    .replace(/\s+$/gm, '')    // Remove trailing whitespace
    .replace(/^\s*\n/gm, '\n'); // Remove leading whitespace on lines
}

/**
 * Generate normalized tags (lowercase, trimmed, deduplicated)
 */
export function normalizeTags(tags?: string[]): string[] {
  if (!tags || tags.length === 0) return [];

  return Array.from(
    new Set(
      tags
        .map(tag => tag.toLowerCase().trim())
        .filter(tag => tag.length > 0)
    )
  );
}

// ============================================================================
// Tool Handler Interface
// ============================================================================

/**
 * Result type for memory operations
 */
export interface MemoryOperationResult {
  success: boolean;
  memoryId?: string;
  message: string;
  metadata?: {
    vectorStored?: boolean;
    relationshipDetected?: boolean;
    relationshipType?: RelationshipType;
  };
}

/**
 * Handler function type for save_memory tool
 */
export type SaveMemoryHandler = (
  input: SaveMemoryInput
) => Promise<MemoryOperationResult>;

/**
 * Create a configured save_memory tool handler
 *
 * @param hivemindApiUrl - The HIVE-MIND API URL
 * @param hivemindApiKey - The API key for authentication
 * @returns Handler function for MCP tool
 */
export function createSaveMemoryHandler(
  hivemindApiUrl: string,
  hivemindApiKey: string
): SaveMemoryHandler {
  return async (input: SaveMemoryInput): Promise<MemoryOperationResult> => {
    try {
      // Normalize input
      const normalizedContent = normalizeMemoryContent(input.content);
      const normalizedTags = normalizeTags(input.tags);

      // Prepare payload for HIVE-MIND API
      const payload = {
        content: normalizedContent,
        tags: normalizedTags,
        project: input.project,
        priority: input.priority,
        relationship: input.relationship
      };

      // Send to sovereign EU backend
      const response = await fetch(`${hivemindApiUrl}/api/memories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hivemindApiKey}`,
          'X-Data-Residency': 'EU'  // GDPR compliance header
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API error: ${response.status} - ${errorBody}`);
      }

      const result = await response.json() as {
        id: string;
        vectorStored?: boolean;
        relationship?: { type: RelationshipType }
      };

      return {
        success: true,
        memoryId: result.id,
        message: "Memory secured in HIVE-MIND sovereign storage",
        metadata: {
          vectorStored: result.vectorStored ?? true,
          relationshipDetected: !!result.relationship,
          relationshipType: result.relationship?.type
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to save memory: ${(error as Error).message}`,
        metadata: {
          vectorStored: false,
          relationshipDetected: false
        }
      };
    }
  };
}

// ============================================================================
// MCP Tool Definition (for direct use with @modelcontextprotocol/sdk)
// ============================================================================

/**
 * Tool definition for registration with MCP server
 *
 * Usage:
 * ```typescript
 * const server = new McpServer({ name: "HIVE-MIND", version: "2.0.0" });
 *
 * server.tool(
 *   MEMORY_TOOL_DEFINITION.name,
 *   MEMORY_TOOL_DEFINITION.inputSchema,
 *   MEMORY_TOOL_DEFINITION.handler
 * );
 * ```
 */
export const MEMORY_TOOL_DEFINITION = {
  name: 'save_memory',
  description: 'Save a memory to HIVE-MIND sovereign EU storage. Supports text, code, and structured data with automatic semantic indexing.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The text, code, or data to remember (max 50,000 chars)'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Category tags for organizing memories (max 20)'
      },
      project: {
        type: 'string',
        description: 'Project context (default: "antigravity")'
      },
      priority: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description: 'Importance priority 0-10 (default: 5)'
      },
      relationship: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['updates', 'extends', 'derives'],
            description: 'Relationship to existing memory'
          },
          targetId: {
            type: 'string',
            format: 'uuid',
            description: 'ID of related memory'
          }
        },
        description: 'Triple-operator relationship (Updates/Extends/Derives)'
      }
    },
    required: ['content']
  } as const
};
