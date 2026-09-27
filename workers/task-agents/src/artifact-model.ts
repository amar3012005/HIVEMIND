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

export function trimStoredArtifactPart(part: { type: string; toolName?: string; output?: unknown }) {
  if (part.toolName !== "load_artifact" || !part.output || typeof part.output !== "object") return part;
  const output = part.output as ModelArtifact;
  if (typeof output.body !== "string" || output.body.length < 12000) return part;
  return { ...part, output: artifactForModel(output) };
}
