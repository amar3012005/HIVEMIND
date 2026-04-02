import type { ProviderPrompts } from "../../types/prompts"

// Rough char-to-token ratio. 1 token ≈ 4 chars for English text.
const CHARS_PER_TOKEN = 4
// Max tokens to include per memory result (keep total context under 30K tokens)
const MAX_CONTENT_CHARS = 6000 * CHARS_PER_TOKEN // 6K tokens per memory

interface HivemindResult {
  id?: string
  title?: string
  content?: string
  score?: number
  created_at?: string
  document_date?: string
  metadata?: Record<string, unknown>
}

function toContextLine(result: unknown, index: number): string {
  const r = result as HivemindResult
  const title = r.title || "untitled"
  let content =
    typeof r.content === "string"
      ? r.content
      : typeof r.metadata?.summary === "string"
        ? String(r.metadata.summary)
        : JSON.stringify(result)

  // Truncate very long session content to keep context manageable
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS) + "\n... [truncated]"
  }

  const date = r.document_date || r.created_at || "unknown"
  const score = typeof r.score === "number" ? r.score.toFixed(3) : "n/a"
  return `[Memory ${index + 1}] Date: ${date} | Score: ${score} | ${title}\n${content}`
}

export function buildHivemindAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const lines =
    context.length > 0
      ? context.map((r, i) => toContextLine(r, i)).join("\n\n---\n\n")
      : "No memories found."

  return `You are a precise question-answering assistant. Your task is to answer the question using ONLY the conversation memories provided below.

Question Date: ${questionDate || "Not specified"}
Question: ${question}

=== RETRIEVED MEMORIES ===
${lines}
=== END MEMORIES ===

Instructions:
- Answer using only the memories above — do not guess or use outside knowledge
- Give a direct, concise answer (a few words or a short sentence)
- For dates/times, give the exact value from the memories
- For facts about people, quote what was stated in the conversations
- If the memories do not contain enough information to answer, respond exactly: I don't know

Answer:`
}

export const HIVEMIND_PROMPTS: ProviderPrompts = {
  answerPrompt: buildHivemindAnswerPrompt,
}
