export type ModelArtifact = {
  id: string;
  title: string;
  kind: string;
  contentType: string;
  body: string;
};

// Binary artifacts stay in Durable Object storage. Model sees only bounded text.
export function artifactForModel(artifact: ModelArtifact, observed?: string) {
  const metadata = { id: artifact.id, title: artifact.title, kind: artifact.kind, contentType: artifact.contentType };
  if (artifact.contentType.startsWith("image/")) {
    return { ...metadata, observation: (observed || "").slice(0, 6000), observationSource: observed ? "workers_ai_vision" : "unavailable", note: "Observation describes visible pixels only; verify before saving claims." };
  }
  if (artifact.contentType === "application/pdf") {
    return { ...metadata, note: "Binary PDF omitted from model context. Use rendered preview or a document reader." };
  }
  return { ...metadata, body: artifact.body.slice(0, 12000), truncated: artifact.body.length > 12000 };
}

export function visionObservation(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, 6000);
  if (!value || typeof value !== "object" || depth > 3) return "";
  if (Array.isArray(value)) return value.map((item) => visionObservation(item, depth + 1)).filter(Boolean).join("\n").slice(0, 6000);
  const record = value as Record<string, unknown>;
  for (const key of ["answer", "page_content", "response", "text", "caption", "result", "output", "data", "content"]) {
    const found = visionObservation(record[key], depth + 1);
    if (found) return found;
  }
  return "";
}

export function trimStoredArtifactPart(part: { type: string; toolName?: string; output?: unknown }) {
  if (part.toolName !== "load_artifact" || !part.output || typeof part.output !== "object") return part;
  const output = part.output as ModelArtifact;
  if (typeof output.body !== "string" || output.body.length < 12000) return part;
  return { ...part, output: artifactForModel(output) };
}
