/**
 * TypeScript definitions for @hivemind/sdk
 */

export interface HiveMindConfig {
  url: string;
  apiKey: string;
  userId?: string;
  orgId?: string;
  timeout?: number;
  retries?: number;
}

export interface Memory {
  title: string;
  content: string;
  sourceType?: 'text' | 'code' | 'conversation';
  tags?: string[];
  project?: string;
  metadata?: Record<string, any>;
  userId?: string;
  orgId?: string;
}

export interface CodeMemory {
  content: string;
  filepath: string;
  language?: string;
  title?: string;
  tags?: string[];
}

export interface ConversationMemory {
  title: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp?: string;
  }>;
  platform?: string;
  tags?: string[];
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  tags?: string[];
  userId?: string;
}

export interface QueryOptions {
  limit?: number;
  userId?: string;
  orgId?: string;
}

export interface ListOptions {
  page?: number;
  limit?: number;
  project?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  tags: string[];
  score?: number;
  metadata?: Record<string, any>;
}

export interface QueryResult {
  answer: string;
  memories: SearchResult[];
  sources?: SearchResult[];
}

export interface HealthStatus {
  status: 'ok' | 'error';
  timestamp: string;
  version: string;
}

export class HiveMindError extends Error {
  statusCode: number;
  response: string;
  constructor(message: string, statusCode?: number, response?: string);
}

export class HiveMindClient {
  constructor(config: HiveMindConfig);

  save(memory: Memory): Promise<{ memory_id: string }>;
  saveCode(code: CodeMemory): Promise<{ memory_id: string }>;
  saveConversation(conversation: ConversationMemory): Promise<{ memory_id: string }>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  query(question: string, options?: QueryOptions): Promise<QueryResult>;
  get(memoryId: string): Promise<SearchResult>;
  update(memoryId: string, updates: Partial<Memory>): Promise<SearchResult>;
  delete(memoryId: string): Promise<void>;
  list(options?: ListOptions): Promise<{ memories: SearchResult[]; total: number; page: number }>;
  bulkSave(memories: Memory[]): Promise<Array<{ memory_id: string }>>;
  health(): Promise<HealthStatus>;
  getJobStatus(jobId: string): Promise<any>;
}

export default HiveMindClient;
