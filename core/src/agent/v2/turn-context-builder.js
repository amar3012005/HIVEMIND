function compactTurns(history, limit = 4) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && turn.content)
    .slice(-limit)
    .map((turn) => ({ role: turn.role, content: String(turn.content).slice(0, 1000) }));
}

export function buildTurnContext(input = {}) {
  return Object.freeze({
    message: String(input.message || '').trim(),
    history: compactTurns(input.history),
    language_hint: String(input.language || '').slice(0, 32) || null,
    clock: String(input.now || new Date().toISOString()),
    timezone: String(input.timezone || 'UTC').slice(0, 64),
    compact_profile: String(input.profileContext || '').slice(0, 1800),
    recent_source_refs: (Array.isArray(input.recentSourceRefs) ? input.recentSourceRefs : []).slice(-8)
      .map((source) => ({ title: source.title, url: source.url, retrieved_at: source.retrieved_at || null })),
    recent_context_answer: String(input.recentContextAnswer || '').trim().slice(0, 4000) || null,
    authorized_projects: (Array.isArray(input.projectCatalog) ? input.projectCatalog : []).slice(0, 24)
      .map((project) => ({ id: project.id, name: project.name, slug: project.slug || null })),
  });
}
