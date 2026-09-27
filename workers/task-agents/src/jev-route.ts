export type JevRoute = "direct" | "action";

export function readJevRoute(result: unknown): JevRoute | null {
  if (result && typeof result === "object" && "result" in result) result = result.result;
  if (!result || typeof result !== "object" || !("answers" in result)) return null;
  const answers = result.answers;
  if (!answers || typeof answers !== "object" || !("route" in answers)) return null;
  const route = answers.route;
  if (!route || typeof route !== "object" || !("choice" in route) || !("confidence" in route) || !("probabilities" in route)) return null;
  const choice = route.choice;
  const confidence = route.confidence;
  const probabilities = route.probabilities;
  if ((choice !== "direct" && choice !== "action") || typeof confidence !== "number" || !Number.isFinite(confidence)
    || !probabilities || typeof probabilities !== "object") return null;
  const selected = (probabilities as Record<string, unknown>)[choice];
  const others = Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value);
  if (typeof selected !== "number" || !Number.isFinite(selected) || others.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  return confidence >= 0.85 && selected >= 0.85 && selected - Math.max(...others as number[]) >= 0.2 ? choice : null;
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
    console.log(JSON.stringify({ event: "jev_result", answer }));
    return readJevRoute(result);
  } catch (error) {
    console.warn(JSON.stringify({ event: "jev_error", name: error instanceof Error ? error.name : "unknown" }));
    return null;
  }
}
