import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { HIVEMIND_PROMPTS } from "./prompts"

interface HivemindCreateMemoryResponse {
  success?: boolean
  memory?: { id?: string }
}

interface HivemindSearchResponse {
  results?: unknown[]
  memories?: unknown[]
}

export class HIVEMINDProvider implements Provider {
  name = "hivemind"
  prompts = HIVEMIND_PROMPTS
  concurrency = {
    default: 20,
    ingest: 10,
    search: 20,
  }

  private apiKey: string | null = null
  private baseUrl = "http://localhost:3001/api"

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error("HIVEMIND provider requires HIVEMIND_API_KEY")
    }

    this.apiKey = config.apiKey
    this.baseUrl = this.normalizeBaseUrl((config.baseUrl as string) || this.baseUrl)
    logger.info(`Initialized HIVEMIND provider @ ${this.baseUrl}`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const documentIds: string[] = []

    for (const session of sessions) {
      const content = this.buildSessionContent(session)
      const payload = {
        title: `MemoryBench ${session.sessionId}`,
        content,
        memory_type: "fact",
        project: options.containerTag,
        tags: ["memorybench", "benchmark", "session"],
        metadata: {
          source: "memorybench",
          sessionId: session.sessionId,
          ...(session.metadata || {}),
        },
        skipPredictCalibrate: true,
        skipProcessing: true,
        smartIngest: false,
        benchmarkEnrichment: true,
      }

      const created = await this.request<HivemindCreateMemoryResponse>("POST", "/memories", payload)
      const id = created?.memory?.id || `${session.sessionId}-${Date.now()}`
      documentIds.push(id)
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const completedIds = result.documentIds || []
    onProgress?.({ completedIds, failedIds: [], total: completedIds.length })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const response = await this.request<HivemindSearchResponse>("POST", "/search/quick", {
      query,
      project: options.containerTag,
      limit: options.limit || 15,
      score_threshold: options.threshold ?? 0.15,
    })

    return response?.results || response?.memories || []
  }

  async clear(containerTag: string): Promise<void> {
    await this.request("DELETE", `/memories/delete-all?project=${encodeURIComponent(containerTag)}`)
  }

  private buildSessionContent(session: UnifiedSession): string {
    const date =
      (typeof session.metadata?.formattedDate === "string" && session.metadata.formattedDate) ||
      (typeof session.metadata?.date === "string" && session.metadata.date) ||
      "unknown"

    const messages = session.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")

    return `Session ID: ${session.sessionId}\nSession Date: ${date}\n\nConversation:\n${messages}`
  }

  private normalizeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "")
    return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error("HIVEMIND provider not initialized")
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HIVEMIND API ${method} ${path} failed (${response.status}): ${text}`)
    }

    if (response.status === 204) {
      return {} as T
    }

    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }
}

export default HIVEMINDProvider

