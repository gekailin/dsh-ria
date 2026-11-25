import { resolve } from 'node:path'
import { acceptsProjectCwd, isCoManaged } from '../roles/co-managed.mjs'
import { EXECUTOR_RESELECT_LIMIT, now } from './shared.mjs'

// Deterministic Executor affinity ranking for automatic dispatch.
//
// Pure module: receives Executor snapshots and a ticket context, returns a
// sorted list. Liveness/occupancy checks stay in the controller; ranking is
// unit-testable and deterministic.

import { AUTO_TAG_TURN_THRESHOLD, activeAutoTags, normalizeAutoTagTurnThreshold, TAG_LIMIT, hasTagIntersection, intersectTags, normalizeTags } from '../store/tags.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

function executorTags(executor) {
  return normalizeTags(executor && executor.tags, TAG_LIMIT)
}

function autoTagTurnFor(executor, context = {}) {
  const id = String(executor && executor.sessionId || '')
  const bySession = context.currentTurnBySession && typeof context.currentTurnBySession === 'object' ? context.currentTurnBySession[id] : undefined
  if (Number.isSafeInteger(Number(bySession)) && Number(bySession) >= 0) return Number(bySession)
  if (Number.isSafeInteger(Number(context.currentTurn)) && Number(context.currentTurn) >= 0) return Number(context.currentTurn)
  const lastTurn = Number(executor && executor.lastTurn)
  return Number.isSafeInteger(lastTurn) && lastTurn >= 0 ? lastTurn : 0
}

function autoTagThreshold(context = {}) {
  return normalizeAutoTagTurnThreshold(context && context.autoTagTurnThreshold, AUTO_TAG_TURN_THRESHOLD)
}

function executorAutoTags(executor, context = {}) {
  return activeAutoTags(executor && executor.autoTags, autoTagTurnFor(executor, context), autoTagThreshold(context))
}

function executorRecentTopics(executor) {
  const list = Array.isArray(executor && executor.recentTopics) ? executor.recentTopics : []
  return list.filter(value => typeof value === 'string' && value).slice(0, 5)
}

function recencyBonus(executor, now) {
  const lastUsedAt = Number(executor && executor.lastUsedAt)
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) return 0
  const days = Math.max(0, now - lastUsedAt) / DAY_MS
  return Math.max(0, Math.min(10, 10 - days))
}

/** Hard-filter one Executor snapshot. Optional onReject reports the exact branch. */
export function isExecutorEligible(executor, context = {}) {
  const reject = reason => {
    if (typeof context.onReject === 'function') context.onReject(reason)
    return false
  }
  if (!executor || typeof executor !== 'object') return reject('kind not eligible')
  if (executor.status !== 'idle') return reject('status=' + String(executor.status))
  if (executor.currentTicketId) return reject('currentTicketId=' + String(executor.currentTicketId))
  if (executor.archived === true || executor.archivedAt != null) return reject('archived')
  if (executor.allowAutoDispatch === false) return reject('allowAutoDispatch=false')
  const wantedType = context.executorType || 'work'
  if ((executor.executorType || 'work') !== wantedType) return reject('executorType=' + String(executor.executorType || 'work') + ' wanted=' + wantedType)
  if (context.projectCwd !== undefined && context.projectCwd !== null) {
    // A co-managed ordinary session accepts tickets inside its cwd; a managed
    // Executor is bound to one exact project directory.
    if (isCoManaged(executor)) {
      if (!acceptsProjectCwd(executor, context.projectCwd)) return reject('co-managed cwd filter: projectCwd null or not inside cwd')
    } else {
      const cwd = executor.projectCwd || executor.cwd || null
      if (cwd && cwd !== context.projectCwd) return reject('managed cwd not exact match')
    }
  }
  const ticketTags = normalizeTags(context.ticketTags, TAG_LIMIT)
  const explicit = executorTags(executor)
  const auto = executorAutoTags(executor, context)
  if (context.requireTagMatch === true && ticketTags.length > 0) {
    if (!hasTagIntersection(ticketTags, [...explicit, ...auto])) return reject('requireTagMatch: wanted=' + ticketTags.join(',') + ' but tags=[' + explicit.join(',') + '] autoTags=[' + auto.join(',') + ']')
  }
  return true
}

/** Score one already-eligible Executor. */
export function scoreExecutor(executor, context = {}) {
  const ticketTags = normalizeTags(context.ticketTags, TAG_LIMIT)
  const explicit = executorTags(executor)
  const auto = executorAutoTags(executor, context)
  const recent = executorRecentTopics(executor)
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
  score += recencyBonus(executor, Number.isFinite(context.now) ? context.now : Date.now())
  return { score, matchedExplicitTags, matchedAutoTags, matchedTopic, genericPenalty }
}

/** Rank eligible Executors: score desc, seq asc, sessionId. */
export function rankCandidateExecutors(executors, context = {}) {
  const ranked = []
  for (const executor of Array.isArray(executors) ? executors : []) {
    if (!isExecutorEligible(executor, context)) continue
    ranked.push({ executor, ...scoreExecutor(executor, context) })
  }
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    // Older test fixtures and legacy bindings may carry epoch-millisecond
    // lastUsedAt values far in the past where the recency bonus clamps to zero.
    // Keep the historical newest-first order as the tie-break before seq.
    const leftUsed = Number(left.executor.lastUsedAt) || 0
    const rightUsed = Number(right.executor.lastUsedAt) || 0
    if (leftUsed !== rightUsed) return rightUsed - leftUsed
    const leftSeq = Number(left.executor.seq)
    const rightSeq = Number(right.executor.seq)
    if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) return leftSeq - rightSeq
    return String(left.executor.sessionId || '').localeCompare(String(right.executor.sessionId || ''))
  })
  return ranked
}

// Executor selection moved verbatim from controller.mjs. The ranking functions
// above stay pure; the class carries the liveness/occupancy checks that need
// the controller (via this) and keeps their exact behaviour.

export class ExecutorPool {
  /**
   * Busy is derived from ticket metadata, never from co-management watches. A
   * session is busy while any sub-ticket it executes still has executing=true.
   * This survives a stale executor row and keeps the dispatch race rule intact.
   */
  executingTicketsFor(sessionId) {
    const id = String(sessionId || '')
    if (!id || !this.state || typeof this.state.ticketMetas !== 'function') return []
    return (this.state.ticketMetas() || []).filter(meta =>
      meta && meta.executing === true && String(meta.executorSessionId || '') === id)
  }

  /**
   * Whether a Executor binding may be selected for a ticket. Archived Sessions are
   * excluded even if their binding still exists: archiving hides the session in
   * the UI and the host gate rejects its steps, so handing it work can only
   * block.
   */
  isExecutorSelectable(item, { scope, projectId, projectCwd, executorType = 'work', archived, reservation, automatic = true, ticketTags, requireTagMatch, currentTurn, currentTurnBySession, autoTagTurnThreshold, onReject } = {}) {
    const reject = reason => {
      if (typeof onReject === 'function') onReject(reason)
      return false
    }
    if (!item || (item.kind !== 'managed' && !isCoManaged(item))) return reject('kind not managed/co-managed')
    // Explicit selection bypasses only this flag, never the safety checks below.
    if (automatic && item.allowAutoDispatch === false) return reject('allowAutoDispatch=false')
    const kind = item.executorType === 'reflection' ? 'reflection' : 'work'
    if (kind !== executorType) return reject('executorType=' + kind + ' wanted=' + executorType)
    if (isCoManaged(item)) {
      // Co-managed hard filter: a normal session only runs tickets whose
      // projectCwd is non-empty and inside its cwd. Global tickets (projectCwd
      // null) are never offered to it, automatically or explicitly.
      if (!acceptsProjectCwd(item, projectCwd)) return reject('co-managed cwd filter: projectCwd null or not inside cwd')
    } else if (executorType === 'work') {
      if (scope !== undefined && item.scope !== scope) return reject('scope=' + String(item.scope) + ' wanted=' + scope)
      if (scope === 'project' && item.projectId !== projectId) return reject('projectId mismatch')
      // A ticket that names a project directory must reuse only a Executor with
      // that same cwd. Otherwise an idle Global executor rooted in stateDir would
      // be handed a project ticket it has no sandbox access to.
      if (projectCwd ? item.cwd !== projectCwd : item.projectCwd) return reject('managed cwd not exact match')
    }
    if (item.status !== 'idle') return reject('status=' + String(item.status))
    if (item.currentTicketId) return reject('currentTicketId=' + String(item.currentTicketId))
    // The ticket store is the busy source of truth: an executing child ticket
    // keeps the session occupied even if the executor row is stale or was reset.
    const executing = this.executingTicketsFor(item.sessionId)
    if (executing.length > 0) return reject('executing=true: ' + executing.map(meta => String(meta.ticketId || '')).filter(Boolean).join(','))
    const activeTicket = this.executorTicketId(item)
    if (activeTicket) return reject('active ticket ' + activeTicket)
    const held = this.executorReservations.get(String(item.sessionId))
    if (held && held !== reservation) return reject('reserved')
    if (this.turnStartedAt.has(String(item.sessionId))) return reject('turn started')
    if (this.stoppingExecutors.has(String(item.sessionId))) return reject('stopping')
    const set = archived || this.archivedSessionIds()
    if (set.has(String(item.sessionId))) return reject('archived')
    // Explicit selection bypasses the tag rules (they protect automatic routing,
    // not a user's deliberate choice). Only enforce them when the caller passed
    // a ticket context.
    if (automatic !== false && Array.isArray(ticketTags)) {
      const wanted = normalizeTags(ticketTags, TAG_LIMIT)
      const explicit = normalizeTags(item.tags, TAG_LIMIT)
      const auto = activeAutoTags(item.autoTags, autoTagTurnFor(item, { currentTurn, currentTurnBySession }), autoTagTurnThreshold)
      if (requireTagMatch === true && wanted.length > 0 && !hasTagIntersection(wanted, [...explicit, ...auto])) return reject('requireTagMatch: wanted=' + wanted.join(',') + ' but tags=[' + explicit.join(',') + '] autoTags=[' + auto.join(',') + ']')
    }
    return true
  }

  /**
   * Try the newest candidates in order, dropping bindings whose Session no
   * longer resolves. One dead binding must not fail the dispatch when another
   * idle Executor is available.
   */
  async selectResolvableExecutor(candidates, ticketId = null, reservation, desiredProjectCwd = null, context = {}) {
    const limit = Math.min(EXECUTOR_RESELECT_LIMIT, Array.isArray(candidates) ? candidates.length : 0)
    for (let index = 0; index < limit; index += 1) {
      const item = candidates[index]
      const current = this.state.executor(item.sessionId)
      const executorType = item.executorType === 'reflection' ? 'reflection' : 'work'
      // A managed Executor is bound to its own project; a co-managed session is
      // judged against the ticket's projectCwd (the hard cwd filter).
      const projectCwd = isCoManaged(current) ? (desiredProjectCwd || null) : (item.projectCwd || null)
      if (!this.isExecutorSelectable(current, { scope: item.scope, projectId: item.projectId, projectCwd, executorType, reservation, ...context }) || !this.reserveExecutor(item.sessionId, reservation)) continue
      const started = Date.now()
      let error = ''
      try {
        const resolved = await this.service.resolve(item.sessionId)
        if (resolved && !('error' in resolved)) {
          const busy = await this.service.executorBusy(item.sessionId)
          const latest = this.state.executor(item.sessionId)
          // A terminal report can release ownership before its turn actually
          // ends. Never hand the now-idle binding to a second ticket yet.
          if (busy.busy || busy.unknown || !this.isExecutorSelectable(latest, { scope: item.scope, projectId: item.projectId, projectCwd, executorType, reservation, ...context })) {
            this.releaseExecutorReservation(item.sessionId, reservation)
            continue
          }
          this.install(resolved.agent, 'executor')
          this.state.clearExecutorStop(item.sessionId)
          return latest
        }
        error = resolved && resolved.error ? String(resolved.error.message || resolved.error.code || 'unavailable') : 'executor session is unavailable'
      } catch (caught) {
        error = String(caught && caught.message ? caught.message : caught)
      }
      this.releaseExecutorReservation(item.sessionId, reservation)
      // Remove the stale binding so it cannot repeatedly win selection. Copy
      // completion stats back to coManagement before the record disappears.
      this.state.preserveCoManagedStats(item.sessionId)
      this.state.removeExecutor(item.sessionId)
      this.routerEvent({
        event: 'executor.resolve_failed',
        ticketId,
        sessionId: item.sessionId,
        actor: 'router',
        reason: 'dispatch selection',
        payload: { executorId: item.sessionId, error, latencyMs: Date.now() - started },
      })
      this.log('warn', 'executor ' + item.sessionId + ' failed to resolve (' + error + '); removed, trying the next candidate')
    }
    return null
  }
}
