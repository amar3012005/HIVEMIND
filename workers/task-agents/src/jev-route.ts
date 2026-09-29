export type JevRoute = "action" | "agent_memory_session";

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
  // A staged deliverable must reach Think's operating plan regardless of a
  // contradictory private-memory classification from the fast scorer.
  if (confidentChoice(decisions.work_shape, "staged")) return null;
  // The destination is a model decision about authority, not a phrase match.
  if (confidentChoice(decisions.memory_intent, "agent_session")) return "agent_memory_session";
  if (confidentChoice(decisions.memory_intent, "agent_record")) return confidentChoice(decisions.route, "action") ? "action" : null;
  if (!confidentChoice(decisions.memory_intent, "none", 0.75)) return null;
  // Ordinary fast routing may open tools, but must not skip Think's answer check.
  // A saved or multi-stage deliverable always needs Think's operating plan.
  return confidentChoice(decisions.route, "action") && confidentChoice(decisions.work_shape, "bounded") ? "action" : null;
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
        memory_intent: {
          type: "choice",
          instructions: "Decide the requested memory operation from meaning and authority, not literal phrasing. Distinguish summarizing this room's prior work from saving one explicitly supplied lesson or fact. If the destination is uncertain, select company so Think can decide. Private operating handoffs belong to the agent brain; canonical organization records belong to approval-governed HIVEMIND.",
          criteria: {
            none: "No persistent memory write is requested.",
            agent_session: "Summarize and persist the prior room session as a private operating handoff.",
            agent_record: "Save a specific lesson, decision note, or handoff supplied by the operator in the private agent brain.",
            company: "Publish a canonical organization fact, profile, decision, or other record into HIVEMIND company memory, or the destination is unclear.",
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
        work_shape: {
          type: "choice",
          instructions: "Assess the current request's execution contract independently of the route. A requested saved artifact or a multi-stage deliverable requires a durable operating plan even if the initial lookup is simple. When uncertain, choose staged.",
          criteria: {
            bounded: "A focused answer or single bounded action with no required saved deliverable or multi-stage acceptance criteria.",
            staged: "The request requires a saved artifact, several verified stages, or explicit deliverable acceptance criteria.",
          },
        },
      },
    });
    const payload = result && typeof result === "object" && "result" in result ? result.result : result;
    const answer = payload && typeof payload === "object" && "answers" in payload && payload.answers && typeof payload.answers === "object" && "route" in payload.answers
      ? payload.answers.route : null;
    const memory = payload && typeof payload === "object" && "answers" in payload && payload.answers && typeof payload.answers === "object" && "memory_intent" in payload.answers
      ? payload.answers.memory_intent : null;
    console.log(JSON.stringify({ event: "jev_result", answer, memory }));
    return readJevRoute(result);
  } catch (error) {
    console.warn(JSON.stringify({ event: "jev_error", name: error instanceof Error ? error.name : "unknown" }));
    return null;
  }
}
