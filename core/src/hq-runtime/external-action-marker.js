function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMarker(value, artifact) {
  const marker = asObject(value);
  const id = String(marker.id || '').trim();
  const presentationType = String(marker.presentation_type || '').trim();
  if (!id || !presentationType) return null;
  return {
    ...marker,
    id,
    presentation_type: presentationType,
    provider: String(marker.provider || '').trim() || null,
    channel: String(marker.channel || marker.provider || '').trim() || null,
    status: String(marker.status || artifact?.status || '').trim() || null,
    artifact_ref: artifact?.id || null,
  };
}

export function collectExternalActionMarkers(artifacts = []) {
  const markers = [];
  for (const artifact of artifacts) {
    const data = asObject(artifact?.data);
    const candidates = [
      ...asArray(data.external_action_markers),
      ...(data.external_action_marker ? [data.external_action_marker] : []),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeMarker(candidate, artifact);
      if (normalized) markers.push(normalized);
    }
  }
  return [...new Map(markers.map((marker) => [marker.id, marker])).values()];
}

export function projectExternalActionEvent({ run, stage, artifacts = [] } = {}) {
  const items = collectExternalActionMarkers(artifacts);
  if (!items.length) return null;
  const artifactRefs = [...new Set(items.map((item) => item.artifact_ref).filter(Boolean))];
  const identity = items.map((item) => item.id).sort().join(':');
  return {
    idempotencyKey: `external-action:${run.id}:${stage.id}:${identity}`,
    eventType: 'external_action_committed',
    title: items.length === 1 ? (items[0].headline || 'External action completed') : `${items.length} external actions completed`,
    summary: items.length === 1
      ? (items[0].note || 'The provider accepted this action and returned durable evidence.')
      : `${items.length} provider-confirmed actions are ready to review.`,
    details: {
      runtime_playbook_run_id: run.id,
      playbook_id: run.playbookId,
      playbook_version: run.playbookVersion,
      stage_id: stage.id,
      item_count: items.length,
      items,
    },
    evidenceRefs: artifactRefs,
  };
}
