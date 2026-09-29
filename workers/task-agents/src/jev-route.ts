export type JevRoute = "action" | "agent_memory";

function confidentChoice(answer: unknown, expected: string, threshold = 0.85): boolean {
  if (!answer || typeof answer !== "object") return false;
  const value = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (value.choice !== expected || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
    || !value.probabilities || typeof value.probabilities !== "object") return false;
  const probabilities = value.probabilities as Record<string, unknown>;
  const selected = probabilities[expected];
  const others = Object.entries(probabilities).filter(([key]) => key !== expected).map(([, probability]) => probability);
  return typeof selected === "number" && Number.isFinite(selected)
    && others.every((probability) => typeof probability === "number" && Number.isFinite(probability))
    && value.confidence >= threshold && selected >= threshold
    && selected - Math.max(...others as number[]) >= 0.2;
}

export function readJevRoute(result: unknown): JevRoute | null {
  if (result && typeof result === "object" && "result" in result) result = result.result;
  if (!result || typeof result !== "object" || !("answers" in result)) return null;
  const answers = result.answers;
  if (!answers || typeof answers !== "object") return null;
  const decisions = answers as Record<string, unknown>;
  // The destination is a model decision about authority, not a phrase match.
  if (confidentChoice(decisions.memory_destination, "agent")) return "agent_memory";
  if (!confidentChoice(decisions.memory_destination, "none", 0.75)) return null;
  // Ordinary fast routing may open tools, but must not skip Think's answer check.
  return confidentChoice(decisions.route, "action") ? "action" : null;
}

export async function routeWithJev(
  ai: { run(model: string, input: unknown): Promise<unknown> } | undefined,
  input: { request: string; previousRequest?: string; company?: string },
): Promise<JevRoute | null> {
  if (!ai) return null;
  try {
    const result = await ai.run("typesafe/jev", {
      state: {
        request: input.request.slice(0, 2000),
        previousRequest: input.previousRequest?.slice(0, 400) || "",
        company: input.company?.slice(0, 120) || "",
      },
      questions: {
        memory_destination: {
          type: "choice",
          instructions: "Does the operator request persistent storage, and which brain owns that information? Decide from meaning and authority, not literal phrasing. If uncertain, choose none so Think can clarify the destination. A private operating handoff belongs only in the agent brain; canonical organization facts belong to the approval-governed company brain.",
          criteria: {
            none: "No persistent memory write is requested, or the requested destination is unclear.",
            agent: "A request to persist this agent's working context, session handoff, or reusable learning in its private operating brain.",
            company: "A request to publish a fact, profile, decision, or other record into canonical HIVEMIND company memory.",
          },
        },
        route: {
          type: "choice",
          instructions: "Choose the minimum sufficient route for this current request. Earlier requests are context only. If request refers to earlier work and is unclear, choose company.",
          criteria: {
            direct: "Greeting, general knowledge, calculation, or transformation using only facts supplied in current request; no tool or company history needed.",
            action: "Focused task or question needing tool, skill, company memory, connected app, screenshot, or simple file; no company operating plan.",
            company: "Substantive multi-step company research, strategy, decision, plan, report, fundraising deliverable, or uncertain reference to prior company work.",
          },
        },
      },
    });
    const payload = result && typeof result === "object" && "result" in result ? result.result : result;
    const answer = payload && typeof payload === "object" && "answers" in payload && payload.answers && typeof payload.answers === "object" && "route" in payload.answers
      ? payload.answers.route : null;
    const memory = payload && typeof payload === "object" && "answers" in payload && payload.answers && typeof payload.answers === "object" && "memory_destination" in payload.answers
      ? payload.answers.memory_destination : null;
    console.log(JSON.stringify({ event: "jev_result", answer, memory }));
    return readJevRoute(result);
  } catch (error) {
    console.warn(JSON.stringify({ event: "jev_error", name: error instanceof Error ? error.name : "unknown" }));
    return null;
  }
}
