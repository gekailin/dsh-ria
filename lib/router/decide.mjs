function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function asNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function normalizeRouterScores(candidates, parsed) {
  const rows = Array.isArray(parsed?.scores) ? parsed.scores : []
  const byKey = new Map()

  // Models sometimes return the short label (for example "dsh-ria") instead of
  // the fully qualified candidate id ("project:dsh-ria"). Accept both.
  for (const candidate of candidates) {
    const keys = new Set([
      candidate.id,
      candidate.label,
      ...String(candidate.id).split(':'),
    ])
    for (const key of keys) {
      byKey.set(String(key).trim().toLowerCase(), candidate.id)
    }
  }

  const byCandidate = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rawId = String(row.candidate_id ?? row.id ?? '').trim()
    if (!rawId) continue
    const candidateId = byKey.get(rawId.toLowerCase()) || rawId
    byCandidate.set(candidateId, {
      rawScore: clamp(asNumber(row.score, 0), 0, 10),
      confidence: clamp(asNumber(row.confidence, 0), 0, 1),
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 80) : '',
    })
  }

  return candidates.map(candidate => {
    const scored = byCandidate.get(candidate.id)
    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      rawScore: scored?.rawScore ?? 0,
      confidence: scored?.confidence ?? 0,
      reason: scored?.reason ?? 'missing from model output',
      missing: !scored,
    }
  })
}

export function decideRoute({ mode, candidates, parsed, options = {} }) {
  const threshold = options.threshold ?? 5
  const strong = options.strong ?? 7
  const margin = options.margin ?? 1
  const newSessionPenalty = options.newSessionPenalty ?? 0.5

  const items = normalizeRouterScores(candidates, parsed).map(item => ({
    ...item,
    adjusted: item.rawScore - (item.id === 'new_session' ? newSessionPenalty : 0),
  }))

  const ranked = [...items].sort((left, right) => {
    if (right.adjusted !== left.adjusted) return right.adjusted - left.adjusted
    if (right.rawScore !== left.rawScore) return right.rawScore - left.rawScore
    return left.id.localeCompare(right.id)
  })

  const top = ranked[0]
  const second = ranked[1]
  const gap = top ? (second ? top.adjusted - second.adjusted : top.adjusted) : 0

  const result = (action, candidateId, reason, rule) => ({
    action,
    candidateId,
    reason,
    rule,
    threshold,
    strong,
    margin,
    gap: Number(gap.toFixed(2)),
    top: top
      ? {
          id: top.id,
          rawScore: top.rawScore,
          adjusted: Number(top.adjusted.toFixed(2)),
          confidence: top.confidence,
        }
      : null,
    ranked: ranked.map(item => ({
      id: item.id,
      kind: item.kind,
      score: item.rawScore,
      adjusted: Number(item.adjusted.toFixed(2)),
      confidence: item.confidence,
      missing: item.missing,
      reason: item.reason,
    })),
    noFit: clamp(asNumber(parsed?.no_fit, 0), 0, 10),
    needsClarification: Boolean(parsed?.needs_clarification),
  })

  if (!top) return result('ask', 'ask', 'no candidates were scored', 'empty-ranking')
  if (top.id === 'ask') return result('ask', 'ask', top.reason || 'model selected ask', 'model-ask')
  if (top.id === 'return_to_think') {
    return result('return_to_think', 'return_to_think', top.reason || 'model selected return_to_think', 'model-return')
  }

  if (top.adjusted < threshold) {
    const fallback = mode === 'session' && items.some(item => item.id === 'return_to_think')
      ? 'return_to_think'
      : 'ask'
    return result(fallback, fallback, 'top score ' + top.rawScore + ' is below threshold ' + threshold, 'below-threshold')
  }

  if (top.id === 'new_session' && top.adjusted < strong) {
    return result('ask', 'ask', 'new_session is not strong enough; ask before creating a session', 'weak-new-session')
  }

  if (parsed?.needs_clarification && top.adjusted < strong) {
    return result('ask', 'ask', 'model marked needs_clarification and no candidate is strong', 'needs-clarification')
  }

  if (clamp(asNumber(parsed?.no_fit, 0), 0, 10) >= strong && top.adjusted < strong) {
    return result('ask', 'ask', 'model marked high no_fit and no candidate is strong', 'high-no-fit')
  }

  if (top.adjusted >= strong && gap >= margin) {
    if (top.id === 'new_session') {
      return result('new_session', 'new_session', top.reason || 'new session wins clearly', 'clear-new-session')
    }
    return result('route', top.id, top.reason || 'clear winner', 'clear-winner')
  }

  if (top.id === 'global') {
    const specific = ranked.find(item =>
      (item.kind === 'project' || item.kind === 'session') &&
      item.rawScore >= top.rawScore - 0.5
    )
    if (specific) {
      return result('route', specific.id, 'tie-break: prefer concrete project/session over global', 'tie-specific-over-global')
    }
  }

  if (top.id === 'new_session') {
    const existing = ranked.find(item => item.kind === 'session' && item.rawScore >= strong - 1)
    if (existing) {
      return result('route', existing.id, 'tie-break: prefer existing session over new session', 'tie-existing-over-new')
    }
  }

  if (gap < margin) {
    return result('ask', 'ask', 'top candidates are too close; ask instead of guessing', 'close-scores')
  }

  if (top.id === 'new_session') {
    return result('new_session', 'new_session', top.reason || 'new session selected', 'new-session')
  }

  return result('route', top.id, top.reason || 'top candidate selected', 'top-candidate')
}

export function decisionMatches(decision, acceptable = []) {
  if (!decision) return false
  return acceptable.includes(decision.candidateId) || acceptable.includes(decision.action)
}
