import type { ProviderPrompts } from "../../types/prompts"

interface HivemindResult {
  id?: string
  title?: string
  content?: string
  score?: number
  created_at?: string
  document_date?: string
  metadata?: Record<string, unknown>
}

function toContextLine(result: unknown): string {
  const r = result as HivemindResult
  const title = r.title || "untitled"
  const content =
    typeof r.content === "string"
      ? r.content
      : typeof r.metadata?.summary === "string"
        ? String(r.metadata.summary)
        : JSON.stringify(result)
  const date = r.document_date || r.created_at || "unknown"
  const score = typeof r.score === "number" ? r.score.toFixed(3) : "n/a"
  return `- [${date}] (${score}) ${title}: ${content}`
}

export function buildHivemindAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const lines = context.length > 0 ? context.map(toContextLine).join("\n") : "- No memories found."

  return `You are a question-answering system. Answer using only the retrieved memories.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Memory Context:
${lines}

Rules:
- Use only evidence in the memory context above
- Prioritize newer or higher-scored entries when information conflicts
- If information is insufficient, respond exactly: I don't know
- Keep the answer concise and factual

Answer:`
}

export const HIVEMIND_PROMPTS: ProviderPrompts = {
  answerPrompt: buildHivemindAnswerPrompt,
}

