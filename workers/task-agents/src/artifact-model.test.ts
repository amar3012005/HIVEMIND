import assert from "node:assert/strict";
import test from "node:test";
import { artifactForModel, trimStoredArtifactPart } from "./artifact-model.ts";

test("binary artifact never enters model context or stored tool history", () => {
  const artifact = { id: "image-1", title: "ICARUS", kind: "image", contentType: "image/jpeg", body: "A".repeat(1_400_000) };
  const visible = artifactForModel(artifact, "ICARUS v2 — In Production");
  assert.equal(visible.observation, "ICARUS v2 — In Production");
  assert.ok(!JSON.stringify(visible).includes("A".repeat(100)));
  const repaired = trimStoredArtifactPart({ type: "tool-load_artifact", toolName: "load_artifact", output: artifact });
  assert.ok(JSON.stringify(repaired).length < 1000);
});
