// Co-management (watch) transport state and relay pipeline.
//
// This module owns only the transport layer: which independent sessions are
// watched, per-watch cursors/options, dedupe/merge/rate-limit and bounded
// in-memory retry for relay text. Tickets, approvals, audit and routing stay in
// the controller and reuse the same risk/audit machinery as managed Executors.
// It is deliberately independent from direct mode: no shared dedupe, no
// arbitration, no suppression between the two.

import { randomUUID } from 'node:crypto'
import { hasExecutorStats, normalizeExecutorStats } from '../store/executor-stats.mjs'

export const MAX_WATCHES = 20
export const DEDUPE_CAPACITY = 2000
export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000]
export const DEFAULT_RATE_LIMIT = { maxPerMin: 6, mergeWindowMs: 5000, windowMs: 60_000 }

const text = value => typeof value === 'string' ? value.trim() : ''
const clone = value => JSON.parse(JSON.stringify(value))
const nowDefault = () => Date.now()

function watchId() {
  return 'watch_' + Date.now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 8)
}

function normalizeOptions(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const rate = value.rateLimit && typeof value.rateLimit === 'object' ? value.rateLimit : {}
  return {
    relayReplies: value.relayReplies !== false,
    relayQuestions: value.relayQuestions !== false,
    rateLimit: {
      maxPerMin: Number.isInteger(rate.maxPerMin) && rate.maxPerMin > 0 ? Math.min(60, rate.maxPerMin) : DEFAULT_RATE_LIMIT.maxPerMin,
      mergeWindowMs: Number.isFinite(rate.mergeWindowMs) && rate.mergeWindowMs >= 0 ? Math.min(60_000, rate.mergeWindowMs) : DEFAULT_RATE_LIMIT.mergeWindowMs,
      windowMs: Number.isFinite(rate.windowMs) && rate.windowMs > 0 ? rate.windowMs : DEFAULT_RATE_LIMIT.windowMs,
    },
  }
}

function normalizeWatch(raw) {
  if (!raw || typeof raw !== 'object' || !text(raw.sessionId)) return null
  const durableStats = hasExecutorStats(raw.stats) ? normalizeExecutorStats(raw.stats) : {}
  return {
    watchId: text(raw.watchId) || watchId(),
    sessionId: String(raw.sessionId),
    titleSnapshot: text(raw.titleSnapshot) || text(raw.title) || String(raw.sessionId),
    cwd: text(raw.cwd) || null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean).slice(0, 12) : [],
    roleNote: text(raw.roleNote) || '',
    allowDispatch: raw.allowDispatch !== false && raw.allowAutoDispatch !== false,
    manual: raw.manual === true,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    // Watches registered before the role rename stored 'chat'; normalize on read.
    addedBy: text(raw.addedBy) || 'chat',
    status: ['active', 'inactive', 'paused', 'stale', 'revoked'].includes(raw.status) ? raw.status : 'active',
    options: normalizeOptions(raw.options),
    cursors: {
      lastRelayedSeq: Number.isSafeInteger(raw.cursors && raw.cursors.lastRelayedSeq) ? raw.cursors.lastRelayedSeq : 0,
      lastUserSeq: Number.isSafeInteger(raw.cursors && raw.cursors.lastUserSeq) ? raw.cursors.lastUserSeq : 0,
    },
    stats: {
      relayed: Number.isSafeInteger(raw.stats && raw.stats.relayed) ? raw.stats.relayed : 0,
      suppressed: Number.isSafeInteger(raw.stats && raw.stats.suppressed) ? raw.stats.suppressed : 0,
      lastRelayAt: Number.isFinite(raw.stats && raw.stats.lastRelayAt) ? raw.stats.lastRelayAt : 0,
      // Completion stats share the stats object with relay counters. Only add
      // them when the record already carries them, so a legacy watch does not
      // masquerade as an empty durable stats snapshot.
      ...durableStats,
    },
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
    ...(text(raw.ticketId) ? { ticketId: text(raw.ticketId) } : {}),
    ...(text(raw.staleReason) ? { staleReason: text(raw.staleReason) } : {}),
    ...(Number.isFinite(raw.staleAt) ? { staleAt: raw.staleAt } : {}),
    // Written by retire() when the session is durably archived or gone. Kept
    // across reloads so an inactive registration still says why it retired.
    ...(text(raw.retiredReason) ? { retiredReason: text(raw.retiredReason) } : {}),
    ...(Number.isFinite(raw.retiredAt) ? { retiredAt: raw.retiredAt } : {}),
    ...(Number.isFinite(raw.inactiveAt) ? { inactiveAt: raw.inactiveAt } : {}),
  }
}

/**
 * Durable watch list plus the event-driven relay pipeline.
 *
 * Injected callbacks:
 *  - send(watch, text, event) -> Promise; must reject on delivery failure.
 *  - notify(message) -> void; Chat-visible notice.
 */
export class CoManagement {
  constructor({ stateDir = '', state = null, now = nowDefault, log = () => {}, send, notify, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, maxWatches = MAX_WATCHES } = {}) {
    if (!state && !stateDir) throw new Error('CoManagement requires state or stateDir')
    this.stateDir = stateDir
    this.state = state
    this.now = now
    this.log = log
    this.send = typeof send === 'function' ? send : async () => {}
    this.notify = typeof notify === 'function' ? notify : () => {}
    this.retryDelaysMs = Array.isArray(retryDelaysMs) ? retryDelaysMs.filter(delay => Number.isFinite(delay) && delay >= 0).slice(0, 3) : DEFAULT_RETRY_DELAYS_MS.slice()
    this.maxWatches = maxWatches
    this.data = { version: 1, watches: [] }
    this.staleNotified = new Set()
    this.dedupe = new Map()
    this.buffers = new Map()
    this.rate = new Map()
    this.pendingQuestions = new Map()
    this.timers = new Set()
    this.load()
  }

  load() {
    const normalize = watches => ({ version: 1, watches: (Array.isArray(watches) ? watches : []).map(normalizeWatch).filter(Boolean).slice(0, this.maxWatches) })
    try {
      if (this.state && Array.isArray(this.state.data.coManagement)) {
        this.data = normalize(this.state.data.coManagement)
        if (typeof this.state.syncCoManagedExecutors === 'function') this.state.syncCoManagedExecutors()
        return
      }
      if (this.state) {
        const legacyExecutors = Object.values(this.state.data.executors || {}).filter(item => item && item.kind === 'co-managed')
        if (legacyExecutors.length) {
          const migrated = legacyExecutors
            .map(executor => normalizeWatch({
              ...executor,
              titleSnapshot: executor.titleSnapshot || executor.title,
              relay: executor.relay || executor.options,
              // Legacy co-managed executor records may still hold the learned
              // stats. Carry them into the new durable stats carrier.
              stats: { ...(executor.stats && typeof executor.stats === 'object' ? executor.stats : {}), ...normalizeExecutorStats(executor) },
            }))
            .filter(Boolean)
            .slice(0, this.maxWatches)
          this.state.data.coManagement = migrated
          if (typeof this.state.syncCoManagedExecutors === 'function') this.state.syncCoManagedExecutors()
          this.state.save()
          this.data = normalize(migrated)
          return
        }
      }
      this.data = { version: 1, watches: [] }
    } catch (error) {
      this.log('warn', 'could not load coManagement state: ' + String(error && error.message ? error.message : error))
      this.data = { version: 1, watches: [] }
    }
  }

  save() {
    if (!this.state) return
    const durable = Array.isArray(this.state.data.coManagement) ? this.state.data.coManagement : []
    const bySession = new Map(durable.map(item => [String(item && item.sessionId || ''), item]))
    // The watch list owns relay counters, while the store owns Executor
    // completion stats (which may have been written after this in-memory watch
    // was built). Merge the durable executor stats instead of replacing them
    // with a stale watch snapshot.
    this.state.data.coManagement = this.data.watches.map(watch => {
      const next = clone(watch)
      const stored = bySession.get(String(watch.sessionId || ''))
      const storedStats = stored && stored.stats && typeof stored.stats === 'object' ? stored.stats : null
      if (storedStats) {
        const executorStats = hasExecutorStats(storedStats) ? normalizeExecutorStats(storedStats) : {}
        next.stats = { ...(next.stats && typeof next.stats === 'object' ? next.stats : {}), ...executorStats }
      }
      // Keep the in-memory watch in step with the merged durable stats, so a
      // caller that reads watch().stats sees the same autoTags/ledger that
      // state.coManagement carries.
      watch.stats = next.stats
      return next
    })
    if (typeof this.state.syncCoManagedExecutors === 'function') this.state.syncCoManagedExecutors()
    this.state.save()
  }

  watches() {
    return this.data.watches.map(clone)
  }

  watch(target) {
    const value = String(target || '')
    if (!value) return null
    const found = this.data.watches.find(item => item.watchId === value || item.sessionId === value)
    return found ? clone(found) : null
  }

  active(sessionId) {
    const found = this.data.watches.find(item => item.sessionId === String(sessionId) && item.status === 'active')
    return found ? clone(found) : null
  }

  add({ sessionId, title, cwd, tags, roleNote, allowDispatch, manual = false, addedBy = 'chat', options, relay, reason = '', ticketId = '' } = {}) {
    const id = String(sessionId || '')
    if (!id) return { ok: false, code: 'session_required', message: 'sessionId is required' }
    const existing = this.data.watches.find(item => item.sessionId === id && item.status !== 'revoked')
    if (existing) {
      if (existing.status === 'inactive') {
        existing.status = 'active'
        // Explicit re-add is the only way back from a retire. History stays in
        // the router event log; the live entry no longer claims to be retired.
        delete existing.retiredReason
        delete existing.retiredAt
        existing.titleSnapshot = text(title) || existing.titleSnapshot
        if (cwd !== undefined) existing.cwd = text(cwd) || existing.cwd
        if (tags !== undefined) existing.tags = Array.isArray(tags) ? tags.map(text).filter(Boolean).slice(0, 12) : existing.tags
        if (roleNote !== undefined) existing.roleNote = text(roleNote)
        if (allowDispatch !== undefined) existing.allowDispatch = allowDispatch !== false
        if (relay !== undefined) existing.options = normalizeOptions(relay)
        this.save()
        return { ok: true, watch: clone(existing), existing: true, reactivated: true }
      }
      return { ok: true, watch: clone(existing), existing: true }
    }
    if (this.data.watches.filter(item => item.status !== 'inactive' && item.status !== 'revoked').length >= this.maxWatches) {
      return { ok: false, code: 'watch_limit', message: 'at most ' + this.maxWatches + ' watched sessions' }
    }
    const watch = normalizeWatch({
      watchId: watchId(),
      sessionId: id,
      titleSnapshot: text(title) || id,
      cwd: text(cwd) || null,
      tags: Array.isArray(tags) ? tags : [],
      roleNote: text(roleNote) || '',
      allowDispatch: allowDispatch !== false,
      manual: manual === true,
      addedAt: this.time(),
      addedBy,
      ...(text(reason) ? { reason: text(reason) } : {}),
      ...(text(ticketId) ? { ticketId: text(ticketId) } : {}),
      status: 'active',
      options: relay && typeof relay === 'object' ? relay : (options && typeof options === 'object' ? options : undefined),
      cursors: { lastRelayedSeq: 0, lastUserSeq: 0 },
      stats: { relayed: 0, suppressed: 0, lastRelayAt: 0 },
    })
    this.data.watches.push(watch)
    this.save()
    return { ok: true, watch: clone(watch), existing: false }
  }

  update(target, patch = {}) {
    const wanted = String(target || '')
    const watch = this.data.watches.find(item => item.watchId === wanted || item.sessionId === wanted)
    if (!watch) return { ok: false, code: 'watch_missing' }
    for (const key of ['title', 'titleSnapshot', 'cwd', 'roleNote']) if (patch[key] !== undefined) watch[key === 'title' ? 'titleSnapshot' : key] = text(patch[key]) || (key === 'cwd' ? null : watch[key])
    if (patch.tags !== undefined) watch.tags = Array.isArray(patch.tags) ? patch.tags.map(text).filter(Boolean).slice(0, 12) : []
    if (patch.allowDispatch !== undefined) watch.allowDispatch = patch.allowDispatch !== false
    if (patch.relay !== undefined || patch.options !== undefined) watch.options = normalizeOptions(patch.relay || patch.options)
    if (patch.addedBy !== undefined) watch.addedBy = text(patch.addedBy) || watch.addedBy
    if (patch.reason !== undefined) watch.reason = text(patch.reason)
    if (patch.ticketId !== undefined) watch.ticketId = text(patch.ticketId)
    // set/update reactivates an entry that was only marked inactive by remove
    // or by an automatic retire.
    watch.status = 'active'
    delete watch.retiredReason
    delete watch.retiredAt
    this.save()
    return { ok: true, watch: clone(watch) }
  }

  remove({ sessionId, all = false } = {}) {
    const wantedSession = text(sessionId)
    if (all !== true && !wantedSession) {
      return { ok: false, code: 'target_required', message: 'sessionId or all is required' }
    }
    let marked = 0
    const at = this.time()
    for (const watch of this.data.watches) {
      if (all !== true && watch.sessionId !== wantedSession) continue
      if (watch.status === 'inactive') continue
      watch.status = 'inactive'
      watch.inactiveAt = at
      marked += 1
    }
    if (marked) this.save()
    return { ok: true, removed: marked }
  }

  /**
   * Flip one registration to inactive because its Session is durably archived
   * or no longer exists. This is the ONLY automatic lifecycle change: the entry
   * itself, autoTags, stats, tags, options and every user field stay untouched.
   *
   * Idempotent: an already-inactive entry is returned with already=true and is
   * never re-stamped, so the caller can log co.auto_retired exactly once.
   */
  retire(sessionId, reason = 'archived') {
    const id = String(sessionId || '')
    const watch = this.data.watches.find(item => item.sessionId === id)
    if (!watch) return { ok: false, code: 'watch_missing' }
    if (watch.status === 'inactive') return { ok: true, watch: clone(watch), already: true }
    const previous = { status: watch.status, retiredReason: watch.retiredReason, retiredAt: watch.retiredAt }
    const at = this.time()
    const retireReason = text(reason) || 'archived'
    watch.status = 'inactive'
    watch.retiredReason = retireReason
    watch.retiredAt = at
    try {
      this.save()
    } catch (error) {
      watch.status = previous.status
      if (previous.retiredReason === undefined) delete watch.retiredReason
      else watch.retiredReason = previous.retiredReason
      if (previous.retiredAt === undefined) delete watch.retiredAt
      else watch.retiredAt = previous.retiredAt
      return { ok: false, code: 'save_failed', message: String(error && error.message ? error.message : error) }
    }
    return { ok: true, watch: clone(watch), already: false, reason: retireReason }
  }

  markStale(sessionId, reason = '会话已归档或不可用') {
    const watch = this.data.watches.find(item => item.sessionId === String(sessionId))
    if (!watch) return { ok: false, code: 'watch_missing' }
    if ((watch.status === 'stale' && watch.staleReason) || this.staleNotified.has(watch.watchId)) return { ok: true, watch: clone(watch), already: true }
    this.staleNotified.add(watch.watchId)
    watch.status = 'stale'
    watch.staleReason = text(reason) || '会话已归档或不可用'
    watch.staleAt = this.time()
    this.save()
    this.notify('【协管·' + watch.titleSnapshot + '】会话已归档或不可用：' + watch.staleReason)
    return { ok: true, watch: clone(watch), already: false }
  }

  touchCursor(sessionId, patch = {}) {
    const watch = this.data.watches.find(item => item.sessionId === String(sessionId))
    if (!watch) return null
    if (Number.isSafeInteger(patch.lastRelayedSeq) && patch.lastRelayedSeq > watch.cursors.lastRelayedSeq) watch.cursors.lastRelayedSeq = patch.lastRelayedSeq
    if (Number.isSafeInteger(patch.lastUserSeq) && patch.lastUserSeq > watch.cursors.lastUserSeq) watch.cursors.lastUserSeq = patch.lastUserSeq
    this.save()
    return clone(watch)
  }

  seen(sessionId, seq) {
    if (!Number.isSafeInteger(seq)) return false
    const now = this.time()
    for (const [key, at] of this.dedupe) {
      if (now - at > DEDUPE_TTL_MS) this.dedupe.delete(key)
    }
    const key = String(sessionId) + ':' + seq
    if (this.dedupe.has(key)) return true
    this.dedupe.set(key, now)
    while (this.dedupe.size > DEDUPE_CAPACITY) {
      const oldest = this.dedupe.keys().next().value
      this.dedupe.delete(oldest)
    }
    return false
  }

  schedule(key, delay, callback, unref = true) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      callback()
    }, Math.max(0, delay))
    if (unref && typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    return timer
  }

  onAssistant(sessionId, payload = {}) {
    const watch = this.active(sessionId)
    if (!watch || watch.options.relayReplies === false) return { ok: false, code: 'watch_inactive' }
    const seq = Number.isSafeInteger(payload.seq) ? payload.seq : undefined
    if (seq !== undefined && seq <= watch.cursors.lastRelayedSeq) return { ok: false, code: 'cursor', seq }
    if (seq !== undefined && this.seen(sessionId, seq)) return { ok: false, code: 'duplicate', seq }
    if (seq !== undefined) this.touchCursor(sessionId, { lastRelayedSeq: seq })
    const body = text(payload.text)
    if (!body) return { ok: true, buffered: false, seq }
    const buffer = this.buffers.get(String(sessionId)) || { texts: [], event: null, timer: null, suppressed: 0 }
    buffer.texts.push(body)
    buffer.event = payload.event || buffer.event
    this.buffers.set(String(sessionId), buffer)
    if (!buffer.timer) {
      buffer.timer = this.schedule('merge:' + sessionId, watch.options.rateLimit.mergeWindowMs, () => {
        const current = this.buffers.get(String(sessionId))
        if (current) current.timer = null
        void this.flush(sessionId)
      })
    }
    return { ok: true, buffered: true, seq }
  }

  onUserMessage(sessionId, payload = {}) {
    const watch = this.watch(sessionId)
    if (!watch || watch.status !== 'active') return { ok: false, code: 'watch_inactive' }
    const seq = Number.isSafeInteger(payload.seq) ? payload.seq : undefined
    if (seq !== undefined && seq <= watch.cursors.lastUserSeq) return { ok: false, code: 'cursor', seq }
    if (seq !== undefined) this.touchCursor(sessionId, { lastUserSeq: seq })
    const summary = text(payload.text)
    if (summary) this.notify('【协管·' + watch.titleSnapshot + '】用户直接对会话说：' + summary.slice(0, 300))
    return { ok: true, seq }
  }

  onUserQuestion(sessionId, question, meta = {}) {
    const watch = this.active(sessionId)
    if (!watch || watch.options.relayQuestions === false) return { ok: false, code: 'watch_inactive' }
    const key = String(sessionId) + ':' + text(meta.questionId || meta.callId || question)
    if (this.pendingQuestions.has(key)) return { ok: true, duplicate: true }
    this.pendingQuestions.set(key, { sessionId, question: text(question), at: this.time(), ...meta })
    if (this.pendingQuestions.size > 200) {
      const oldest = this.pendingQuestions.keys().next().value
      this.pendingQuestions.delete(oldest)
    }
    this.notify('【协管·' + watch.titleSnapshot + '】在等你回答：' + text(question).slice(0, 1000))
    return { ok: true, key }
  }

  async flush(sessionId) {
    const watch = this.active(sessionId)
    const buffer = this.buffers.get(String(sessionId))
    if (!watch || !buffer || buffer.texts.length === 0) return { ok: false, code: 'empty' }
    const now = this.time()
    const windowMs = watch.options.rateLimit.windowMs
    const times = (this.rate.get(String(sessionId)) || []).filter(at => now - at < windowMs)
    this.rate.set(String(sessionId), times)
    if (times.length >= watch.options.rateLimit.maxPerMin) {
      buffer.suppressed += 1
      if (!buffer.timer) {
        const delay = Math.max(0, times[0] + windowMs - now)
        buffer.timer = this.schedule('rate:' + sessionId, delay, () => {
          const current = this.buffers.get(String(sessionId))
          if (current) current.timer = null
          void this.flush(sessionId)
        })
      }
      return { ok: false, code: 'rate_limited' }
    }
    const texts = buffer.texts.splice(0)
    let body = texts.join('\n')
    if (buffer.suppressed > 0) {
      body += '\n（另有 ' + buffer.suppressed + ' 条输出已省略）'
      buffer.suppressed = 0
    }
    const event = buffer.event
    buffer.event = null
    const delivered = await this.deliver(watch, body, event)
    if (delivered) {
      const current = this.data.watches.find(item => item.sessionId === String(sessionId))
      if (current) {
        current.stats.relayed += 1
        current.stats.lastRelayAt = now
        this.save()
      }
      this.rate.set(String(sessionId), [...times, now])
    }
    return { ok: delivered, relayed: delivered }
  }

  async deliver(watch, body, event) {
    const title = watch.titleSnapshot
    const batchId = watch.watchId + ':' + this.time() + ':' + randomUUID().slice(0, 8)
    const attempt = async index => {
      try {
        await this.send(watch, body, event, batchId)
        return true
      } catch (error) {
        if (index >= this.retryDelaysMs.length) {
          this.notify('⚠️ 协管转述发送失败（已重试 ' + this.retryDelaysMs.length + ' 次）：' + String(error && error.message ? error.message : error))
          return false
        }
        await new Promise(resolve => this.schedule('retry:' + batchId + ':' + index, this.retryDelaysMs[index], resolve, false))
        return await attempt(index + 1)
      }
    }
    return await attempt(0)
  }

  pending() {
    return [...this.pendingQuestions.values()].map(clone)
  }

  close() {
    for (const timer of this.timers) {
      try { clearTimeout(timer) } catch { /* already gone */ }
    }
    this.timers.clear()
    this.buffers.clear()
  }

  time() {
    return typeof this.now === 'function' ? this.now() : Number(this.now) || Date.now()
  }
}
