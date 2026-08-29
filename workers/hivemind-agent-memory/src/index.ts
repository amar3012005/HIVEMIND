import { Agent, getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const PROJECT_INSTANCE = "hivemind";
const CATEGORIES = [
  "decision",
  "architecture_gap",
  "patch_work",
  "incident",
  "release",
  "requirement",
  "gotcha",
  "context"
] as const;
const STATUSES = ["active", "resolved", "superseded"] as const;

type Category = (typeof CATEGORIES)[number];
type MemoryStatus = (typeof STATUSES)[number];

export interface Env {
  PROJECT_MEMORY: DurableObjectNamespace<ProjectMemory>;
  HIVEMIND_AGENT_MEMORY_TOKEN: string;
}

export type MemoryInput = {
  category: Category;
  title: string;
  content: string;
  rationale?: string;
  tags?: string[];
  references?: string[];
  source_worktree?: string;
  source_branch?: string;
  commit_sha?: string;
  dedupe_key?: string;
  supersedes_id?: string;
};

type MemoryRow = {
  id: string;
  category: Category;
  title: string;
  content: string;
  rationale: string;
  status: MemoryStatus;
  tags_json: string;
  references_json: string;
  source_worktree: string;
  source_branch: string;
  commit_sha: string;
  dedupe_key: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryRecord = Omit<MemoryRow, "tags_json" | "references_json"> & {
  tags: string[];
  references: string[];
};

function normalizeStrings(values: string[] | undefined, limit: number): string[] {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function decode(row: MemoryRow): MemoryRecord {
  const { tags_json, references_json, ...memory } = row;
  return {
    ...memory,
    tags: JSON.parse(tags_json || "[]") as string[],
    references: JSON.parse(references_json || "[]") as string[]
  };
}

export class ProjectMemory extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        tags_json TEXT NOT NULL DEFAULT '[]',
        references_json TEXT NOT NULL DEFAULT '[]',
        source_worktree TEXT NOT NULL DEFAULT '',
        source_branch TEXT NOT NULL DEFAULT '',
        commit_sha TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT UNIQUE,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS memories_category_status_idx ON memories(category, status, updated_at DESC)`;
    this.sql`CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at DESC)`;
    this.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED, title, content, rationale, tags, tokenize='porter unicode61'
      )
    `;
  }

  remember(input: MemoryInput): { created: boolean; memory: MemoryRecord } {
    if (input.dedupe_key) {
      const prior = this.sql<MemoryRow>`SELECT * FROM memories WHERE dedupe_key = ${input.dedupe_key} LIMIT 1`[0];
      if (prior) return { created: false, memory: decode(prior) };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = normalizeStrings(input.tags, 50);
    const references = normalizeStrings(input.references, 50);
    const title = input.title.trim();
    const content = input.content.trim();
    const rationale = input.rationale?.trim() || "";
    if (!title || !content) throw new Error("memory_title_and_content_required");

    if (input.supersedes_id) {
      this.sql`UPDATE memories SET status = 'superseded', updated_at = ${now} WHERE id = ${input.supersedes_id}`;
    }
    this.sql`
      INSERT INTO memories (
        id, category, title, content, rationale, status, tags_json, references_json,
        source_worktree, source_branch, commit_sha, dedupe_key, supersedes_id,
        created_at, updated_at
      ) VALUES (
        ${id}, ${input.category}, ${title}, ${content}, ${rationale}, 'active',
        ${JSON.stringify(tags)}, ${JSON.stringify(references)},
        ${input.source_worktree || ""}, ${input.source_branch || ""}, ${input.commit_sha || ""},
        ${input.dedupe_key || null}, ${input.supersedes_id || null}, ${now}, ${now}
      )
    `;
    this.sql`
      INSERT INTO memories_fts (id, title, content, rationale, tags)
      VALUES (${id}, ${title}, ${content}, ${rationale}, ${tags.join(" ")})
    `;
    return { created: true, memory: this.getMemory(id)! };
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.sql<MemoryRow>`SELECT * FROM memories WHERE id = ${id} LIMIT 1`[0];
    return row ? decode(row) : null;
  }

  searchMemories(query: string, category?: Category, status: MemoryStatus | "all" = "active", limit = 20): MemoryRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const cleaned = query.trim().replace(/["'*:^(){}\[\]]/g, " ").replace(/\s+/g, " ");
    if (!cleaned) return this.listRecent(category, status, safeLimit);
    const match = cleaned.split(" ").filter(Boolean).map((term) => `${term}*`).join(" AND ");
    const rows = this.sql<MemoryRow>`
      SELECT m.* FROM memories_fts f
      JOIN memories m ON m.id = f.id
      WHERE memories_fts MATCH ${match}
        AND (${category || null} IS NULL OR m.category = ${category || null})
        AND (${status} = 'all' OR m.status = ${status})
      ORDER BY bm25(memories_fts), m.updated_at DESC
      LIMIT ${safeLimit}
    `;
    return rows.map(decode);
  }

  listRecent(category?: Category, status: MemoryStatus | "all" = "active", limit = 20): MemoryRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.sql<MemoryRow>`
      SELECT * FROM memories
      WHERE (${category || null} IS NULL OR category = ${category || null})
        AND (${status} = 'all' OR status = ${status})
      ORDER BY updated_at DESC
      LIMIT ${safeLimit}
    `.map(decode);
  }

  setStatus(id: string, status: MemoryStatus): MemoryRecord | null {
    const now = new Date().toISOString();
    this.sql`UPDATE memories SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
    return this.getMemory(id);
  }

  health(): { ok: true; project: string; total: number; active: number; schema_version: number } {
    const total = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memories`[0]?.count || 0;
    const active = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM memories WHERE status = 'active'`[0]?.count || 0;
    return { ok: true, project: PROJECT_INSTANCE, total, active, schema_version: 1 };
  }
}

async function memory(env: Env): Promise<DurableObjectStub<ProjectMemory>> {
  return getAgentByName(env.PROJECT_MEMORY, PROJECT_INSTANCE);
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "HIVEMIND Agent Memory", version: "1.0.0" });

  server.registerTool("memory_remember", {
    description: "Persist a durable HIVEMIND engineering memory. Use for decisions, architecture gaps, patch work, incidents, releases, requirements, gotchas, and important context.",
    inputSchema: {
      category: z.enum(CATEGORIES),
      title: z.string().min(1).max(240),
      content: z.string().min(1).max(100_000),
      rationale: z.string().max(20_000).optional(),
      tags: z.array(z.string().max(120)).max(50).optional(),
      references: z.array(z.string().max(500)).max(50).optional(),
      source_worktree: z.string().max(500).optional(),
      source_branch: z.string().max(300).optional(),
      commit_sha: z.string().max(64).optional(),
      dedupe_key: z.string().max(300).optional(),
      supersedes_id: z.string().uuid().optional()
    }
  }, async (input) => result(await (await memory(env)).remember(input as MemoryInput)));

  server.registerTool("memory_search", {
    description: "Search the shared HIVEMIND engineering memory using full-text search.",
    inputSchema: {
      query: z.string().max(2_000),
      category: z.enum(CATEGORIES).optional(),
      status: z.enum([...STATUSES, "all"] as const).default("active"),
      limit: z.number().int().min(1).max(100).default(20)
    }
  }, async ({ query, category, status, limit }) => result(await (await memory(env)).searchMemories(query, category, status, limit)));

  server.registerTool("memory_get", {
    description: "Read one durable memory by ID.",
    inputSchema: { id: z.string().uuid() }
  }, async ({ id }) => result(await (await memory(env)).getMemory(id)));

  server.registerTool("memory_recent", {
    description: "List the most recently updated shared HIVEMIND memories.",
    inputSchema: {
      category: z.enum(CATEGORIES).optional(),
      status: z.enum([...STATUSES, "all"] as const).default("active"),
      limit: z.number().int().min(1).max(100).default(20)
    }
  }, async ({ category, status, limit }) => result(await (await memory(env)).listRecent(category, status, limit)));

  server.registerTool("memory_set_status", {
    description: "Mark a memory active, resolved, or superseded without deleting its audit history.",
    inputSchema: { id: z.string().uuid(), status: z.enum(STATUSES) }
  }, async ({ id, status }) => result(await (await memory(env)).setStatus(id, status)));

  server.registerTool("memory_health", {
    description: "Verify the shared HIVEMIND Agent Memory and return record counts.",
    inputSchema: {}
  }, async () => result(await (await memory(env)).health()));

  return server;
}

function authorized(request: Request, env: Env): boolean {
  const expected = `Bearer ${env.HIVEMIND_AGENT_MEMORY_TOKEN || ""}`;
  const actual = request.headers.get("authorization") || "";
  if (!env.HIVEMIND_AGENT_MEMORY_TOKEN || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const state = await (await memory(env)).health();
      return Response.json(state);
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!authorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return createMcpHandler(() => createServer(env), { route: "/mcp", legacy: "stateless" })(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
