// Deterministic Worker affinity ranking for automatic dispatch.
//
// Pure module: receives Worker snapshots and a ticket context, returns a
// sorted list. Liveness/occupancy checks stay in the controller; ranking is
// unit-testable and deterministic.

import { AUTO_TAG_LIMIT, TAG_LIMIT, hasTagIntersection, intersectTags, normalizeTags } from './tags.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

function workerTags(worker) {
  return normalizeTags(worker && worker.tags, TAG_LIMIT)
}

function workerAutoTags(worker) {
  return normalizeTags(worker && worker.autoTags, AUTO_TAG_LIMIT)
}

function workerRecentTopics(worker) {
  const list = Array.isArray(worker && worker.recentTopics) ? worker.recentTopics : []
  return list.filter(value => typeof value === 'string' && value).slice(0, 5)
}

function recencyBonus(worker, now) {
  const lastUsedAt = Number(worker && worker.lastUsedAt)
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return 0
  const days = Math.max(0, now - lastUsedAt) / DAY_MS
  return Math.max(0, Math.min(10, 10 - days))
}

/** Hard-filter one Worker snapshot. */
export function isWorkerEligible(worker, context = {}) {
  if (!worker || typeof worker !== 'object') return false
  if (worker.status !== 'idle') return false
  if (worker.currentTicketId) return false
  if (worker.archived === true || worker.archivedAt != null) return false
  if (worker.allowAutoDispatch === false) return false
  const wantedType = context.workerType || 'work'
  if ((worker.workerType || 'work') !== wantedType) return false
  if (context.projectCwd !== undefined && context.projectCwd !== null) {
    const cwd = worker.projectCwd || worker.cwd || null
    if (cwd && cwd !== context.projectCwd) return false
  }
  const ticketTags = normalizeTags(context.ticketTags, TAG_LIMIT)
  const explicit = workerTags(worker)
  const auto = workerAutoTags(worker)
  if (worker.dedicated === true && !hasTagIntersection(ticketTags, explicit)) return false
  if (context.requireTagMatch === true && ticketTags.length > 0) {
    if (!hasTagIntersection(ticketTags, [...explicit, ...auto])) return false
  }
  return true
}

/** Score one already-eligible Worker. */
export function scoreWorker(worker, context = {}) {
  const ticketTags = normalizeTags(context.ticketTags, TAG_LIMIT)
  const explicit = workerTags(worker)
  const auto = workerAutoTags(worker)
  const recent = workerRecentTopics(worker)
  const matchedExplicitTags = intersectTags(ticketTags, explicit)
  const matchedAutoTags = intersectTags(ticketTags, auto).filter(tag => !matchedExplicitTags.includes(tag))
  const topicId = context.primaryTopicId || null
  let matchedTopic = null
  let score = matchedExplicitTags.length * 100
  if (topicId) {
    if (recent[0] === topicId) { score += 60; matchedTopic = 0 }
    else {
      const index = recent.indexOf(topicId, 1)
      if (index >= 1 && index <= 4) { score += 35; matchedTopic = index }
    }
  }
  score += matchedAutoTags.length * 25
  const configuredPenalty = context.genericPenalty === undefined ? 10 : Number(context.genericPenalty)
  const genericPenalty = ticketTags.length === 0 && explicit.length > 0 ? configuredPenalty : 0
  score -= genericPenalty
  score += recencyBonus(worker, Number.isFinite(context.now) ? context.now : Date.now())
  return { score, matchedExplicitTags, matchedAutoTags, matchedTopic, genericPenalty }
}

/** Rank eligible Workers: score desc, seq asc, sessionId. */
export function rankCandidateWorkers(workers, context = {}) {
  const ranked = []
  for (const worker of Array.isArray(workers) ? workers : []) {
    if (!isWorkerEligible(worker, context)) continue
    ranked.push({ worker, ...scoreWorker(worker, context) })
  }
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftSeq = Number(left.worker.seq)
    const rightSeq = Number(right.worker.seq)
    if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) return leftSeq - rightSeq
    return String(left.worker.sessionId || '').localeCompare(String(right.worker.sessionId || ''))
  })
  return ranked
}
