/**
 * HIVE-MIND Core Types
 * Graph-based memory with triple-operator logic
 */

export type UUID = string;

export type RelationshipType = 'Updates' | 'Extends' | 'Derives';

export interface MemoryNode {
  id: UUID;
  content: string;
  embedding?: number[];
  embedding_id?: string;
  user_id: UUID;
  org_id: UUID;
  project?: string;
  tags: string[];
  is_latest: boolean;
  strength: number;
  recall_count: number;
  last_confirmed: Date;
  created_at: Date;
  updated_at: Date;
  document_date?: Date;
  event_dates?: Date[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRelationship {
  id: UUID;
  from_id: UUID;
  to_id: UUID;
  type: RelationshipType;
  confidence: number;
  created_at: Date;
  metadata?: Record<string, unknown>;
}

export interface StoreMemoryInput {
  content: string;
  user_id: UUID;
  org_id: UUID;
  project?: string;
  tags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  relationship?: {
    type: RelationshipType;
    target_id: UUID;
  };
  document_date?: Date;
  event_dates?: Date[];
}

export interface SearchMemoryInput {
  query: string;
  user_id?: UUID;
  org_id?: UUID;
  n_results?: number;
  filter?: MemoryFilter;
  hybrid_weight?: number; // 0-1, vector search weight
}

export interface MemoryFilter {
  tags?: string[];
  project?: string;
  org_id?: UUID;
  is_latest?: boolean;
  created_after?: Date;
  created_before?: Date;
  min_strength?: number;
}

export interface SearchResult {
  memory: MemoryNode;
  score: number;
  vector_score?: number;
  keyword_score?: number;
}

export interface TraverseInput {
  start_id: UUID;
  depth?: number;
  relationship_types?: RelationshipType[];
  direction?: 'OUT' | 'IN' | 'BOTH';
}

export interface TraverseResult {
  nodes: MemoryNode[];
  edges: MemoryRelationship[];
  paths: Path[];
}

export interface Path {
  nodes: MemoryNode[];
  edges: MemoryRelationship[];
}

export interface DecayResult {
  memory_id: UUID;
  recall_probability: number;
  status: 'active' | 'decaying' | 'forgotten';
  half_life_days: number;
}

export interface CompactionResult {
  should_compact: boolean;
  summary?: string;
  new_memory_id?: UUID;
  tokens_freed?: number;
}

// Code chunking types
export interface CodeChunk {
  id: UUID;
  content: string;
  filepath: string;
  start_line: number;
  end_line: number;
  language: string;
  scope_chain?: string;
  signatures?: string[];
  imports?: string[];
  docstrings?: string[];
  nws_count: number;
  entity_type?: 'Class' | 'Method' | 'Function' | 'Interface' | 'Module';
  parent_id?: UUID;
  children_ids?: UUID[];
}

export interface ChunkInput {
  filepath: string;
  content: string;
  language?: string;
  strategy?: 'ast' | 'semantic' | 'hybrid';
  chunk_size_bytes?: number;
  nws_threshold?: number;
}

// MCP Types
export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  mime_type: string;
  content?: string;
}

export interface AutoRecallInput {
  session_id: string;
  query_context: string;
  max_memories?: number;
  weights?: {
    similarity: number;
    recency: number;
    importance: number;
  };
}

export interface AutoRecallResult {
  memories: MemoryNode[];
  scores: number[];
  injection_text: string;
}
