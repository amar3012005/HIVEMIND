export function normalize(value) {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function exactCandidate(plan, candidates) {
  const target = plan?.target
  if (!target) return null

  const matches = candidates.filter(candidate =>
    (!target.role || normalize(candidate.role) === normalize(target.role)) &&
    (!target.name || normalize(candidate.name) === normalize(target.name)),
  )

  return matches.length === 1
    ? { candidate: matches[0], confidence: 1, source: 'deterministic' }
    : null
}

export function ruleCandidate(plan, candidates) {
  const hints = (plan?.hints ?? []).map(normalize).filter(Boolean)
  if (!hints.length) return null

  const ranked = candidates
    .map(candidate => {
      const haystack = [candidate.role, candidate.name, candidate.text, candidate.href]
        .map(normalize)
        .join(' ')
      const score = hints.reduce((total, hint) => total + (haystack.includes(hint) ? 1 : 0), 0)
      return { candidate, score }
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)

  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null
  return {
    candidate: ranked[0].candidate,
    confidence: ranked[0].score / hints.length,
    source: 'rules',
  }
}

export async function chooseCandidate({ plan, candidates, decisionEngine, minimumConfidence }) {
  const deterministic = exactCandidate(plan, candidates)
  if (deterministic) return deterministic

  const rule = ruleCandidate(plan, candidates)
  if (rule && rule.confidence >= minimumConfidence) return rule

  if (!decisionEngine || !candidates.length) return null
  const decision = await decisionEngine.choose({ plan, candidates })
  if (!decision?.candidateId || !Number.isFinite(decision.confidence)) return null
  const candidate = candidates.find(item => item.id === decision.candidateId)
  if (!candidate || decision.confidence < minimumConfidence) return null
  return {
    candidate,
    confidence: decision.confidence,
    source: decision.source ?? 'decision-engine',
    requiresHuman: decision.requiresHuman === true,
  }
}
