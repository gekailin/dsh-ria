import { resolve } from 'node:path'
import { acceptsProjectCwd, isCoManaged } from '../roles/co-managed.mjs'
import { WORKER_RESELECT_LIMIT, now } from './shared.mjs'

// Deterministic Worker affinity ranking for automatic dispatch.
//
// Pure module: receives Worker snapshots and a ticket context, returns a
// sorted list. Liveness/occupancy checks stay in the controller; ranking is
// unit-testable and deterministic.

import { AUTO_TAG_LIMIT, TAG_LIMIT, hasTagIntersection, intersectTags, normalizeTags } from '../store/tags.mjs'

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
    // A co-managed ordinary session accepts tickets inside its cwd; a managed
    // Worker is bound to one exact project directory.
    if (isCoManaged(worker)) {
      if (!acceptsProjectCwd(worker, context.projectCwd)) return false
    } else {
      const cwd = worker.projectCwd || worker.cwd || null
      if (cwd && cwd !== context.projectCwd) return false
    }
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
    // Older test fixtures and legacy bindings may carry epoch-millisecond
    // lastUsedAt values far in the past where the recency bonus clamps to zero.
    // Keep the historical newest-first order as the tie-break before seq.
    const leftUsed = Number(left.worker.lastUsedAt) || 0
    const rightUsed = Number(right.worker.lastUsedAt) || 0
    if (leftUsed !== rightUsed) return rightUsed - leftUsed
    const leftSeq = Number(left.worker.seq)
    const rightSeq = Number(right.worker.seq)
    if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) return leftSeq - rightSeq
    return String(left.worker.sessionId || '').localeCompare(String(right.worker.sessionId || ''))
  })
  return ranked
}

// Worker selection moved verbatim from controller.mjs. The ranking functions
// above stay pure; the class carries the liveness/occupancy checks that need
// the controller (via this) and keeps their exact behaviour.

export class WorkerPool {
  /**
   * Whether a Worker binding may be selected for a ticket. Archived Sessions are
   * excluded even if their binding still exists: archiving hides the session in
   * the UI and the host gate rejects its steps, so handing it work can only
   * block.
   */
  isWorkerSelectable(item, { scope, projectId, projectCwd, workerType = 'work', archived, reservation, automatic = true, ticketTags, requireTagMatch } = {}) {
    if (!item || (item.kind !== 'managed' && !isCoManaged(item))) return false
    // Explicit selection bypasses only this flag, never the safety checks below.
    if (automatic && item.allowAutoDispatch === false) return false
    const kind = item.workerType === 'reflection' ? 'reflection' : 'work'
    if (kind !== workerType) return false
    if (isCoManaged(item)) {
      // Co-managed hard filter: a normal session only runs tickets whose
      // projectCwd is non-empty and inside its cwd. Global tickets (projectCwd
      // null) are never offered to it, automatically or explicitly.
      if (!acceptsProjectCwd(item, projectCwd)) return false
    } else if (workerType === 'work') {
      if (scope !== undefined && item.scope !== scope) return false
      if (scope === 'project' && item.projectId !== projectId) return false
      // A ticket that names a project directory must reuse only a Worker with
      // that same cwd. Otherwise an idle Global worker rooted in stateDir would
      // be handed a project ticket it has no sandbox access to.
      if (projectCwd ? item.cwd !== projectCwd : item.projectCwd) return false
    }
    if (item.status !== 'idle' || item.currentTicketId || this.workerTicketId(item)) return false
    const held = this.workerReservations.get(String(item.sessionId))
    if (held && held !== reservation) return false
    if (this.turnStartedAt.has(String(item.sessionId)) || this.stoppingWorkers.has(String(item.sessionId))) return false
    const set = archived || this.archivedSessionIds()
    if (set.has(String(item.sessionId))) return false
    // Explicit selection bypasses the tag rules (they protect automatic routing,
    // not a user's deliberate choice). Only enforce them when the caller passed
    // a ticket context.
    if (automatic !== false && Array.isArray(ticketTags)) {
      const wanted = normalizeTags(ticketTags, TAG_LIMIT)
      const explicit = normalizeTags(item.tags, TAG_LIMIT)
      if (item.dedicated === true && !hasTagIntersection(wanted, explicit)) return false
      if (requireTagMatch === true && wanted.length > 0 && !hasTagIntersection(wanted, [...explicit, ...normalizeTags(item.autoTags, TAG_LIMIT)])) return false
    }
    return true
  }

  /**
   * Try the newest candidates in order, dropping bindings whose Session no
   * longer resolves. One dead binding must not fail the dispatch when another
   * idle Worker is available.
   */
  async selectResolvableWorker(candidates, ticketId = null, reservation, desiredProjectCwd = null, context = {}) {
    const limit = Math.min(WORKER_RESELECT_LIMIT, Array.isArray(candidates) ? candidates.length : 0)
    for (let index = 0; index < limit; index += 1) {
      const item = candidates[index]
      const current = this.state.worker(item.sessionId)
      const workerType = item.workerType === 'reflection' ? 'reflection' : 'work'
      // A managed Worker is bound to its own project; a co-managed session is
      // judged against the ticket's projectCwd (the hard cwd filter).
      const projectCwd = isCoManaged(current) ? (desiredProjectCwd || null) : (item.projectCwd || null)
      if (!this.isWorkerSelectable(current, { scope: item.scope, projectId: item.projectId, projectCwd, workerType, reservation, ...context }) || !this.reserveWorker(item.sessionId, reservation)) continue
      const started = Date.now()
      let error = ''
      try {
        const resolved = await this.service.resolve(item.sessionId)
        if (resolved && !('error' in resolved)) {
          const busy = await this.service.workerBusy(item.sessionId)
          const latest = this.state.worker(item.sessionId)
          // A terminal report can release ownership before its turn actually
          // ends. Never hand the now-idle binding to a second ticket yet.
          if (busy.busy || busy.unknown || !this.isWorkerSelectable(latest, { scope: item.scope, projectId: item.projectId, projectCwd, workerType, reservation, ...context })) {
            this.releaseWorkerReservation(item.sessionId, reservation)
            continue
          }
          this.install(resolved.agent, 'worker')
          this.state.clearWorkerStop(item.sessionId)
          return latest
        }
        error = resolved && resolved.error ? String(resolved.error.message || resolved.error.code || 'unavailable') : 'worker session is unavailable'
      } catch (caught) {
        error = String(caught && caught.message ? caught.message : caught)
      }
      this.releaseWorkerReservation(item.sessionId, reservation)
      // Remove the stale binding so it cannot repeatedly win selection.
      this.state.removeWorker(item.sessionId)
      this.routerEvent({
        event: 'worker.resolve_failed',
        ticketId,
        sessionId: item.sessionId,
        actor: 'router',
        reason: 'dispatch selection',
        payload: { workerId: item.sessionId, error, latencyMs: Date.now() - started },
      })
      this.log('warn', 'worker ' + item.sessionId + ' failed to resolve (' + error + '); removed, trying the next candidate')
    }
    return null
  }
}
