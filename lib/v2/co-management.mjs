// Co-management (watch) transport state and relay pipeline.
//
// This module owns only the transport layer: which independent sessions are
// watched, per-watch cursors/options, dedupe/merge/rate-limit and bounded
// in-memory retry for relay text. Tickets, approvals, audit and routing stay in
// the controller and reuse the same risk/audit machinery as managed Workers.
// It is deliberately independent from direct mode: no shared dedupe, no
// arbitration, no suppression between the two.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const CO_MANAGEMENT_FILE = 'co-management.json'
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
  return {
    watchId: text(raw.watchId) || watchId(),
    sessionId: String(raw.sessionId),
    titleSnapshot: text(raw.titleSnapshot) || String(raw.sessionId),
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    addedBy: text(raw.addedBy) || 'chatbot',
    status: ['active', 'paused', 'stale', 'revoked'].includes(raw.status) ? raw.status : 'active',
    options: normalizeOptions(raw.options),
    cursors: {
      lastRelayedSeq: Number.isSafeInteger(raw.cursors && raw.cursors.lastRelayedSeq) ? raw.cursors.lastRelayedSeq : 0,
      lastUserSeq: Number.isSafeInteger(raw.cursors && raw.cursors.lastUserSeq) ? raw.cursors.lastUserSeq : 0,
    },
    stats: {
      relayed: Number.isSafeInteger(raw.stats && raw.stats.relayed) ? raw.stats.relayed : 0,
      suppressed: Number.isSafeInteger(raw.stats && raw.stats.suppressed) ? raw.stats.suppressed : 0,
      lastRelayAt: Number.isFinite(raw.stats && raw.stats.lastRelayAt) ? raw.stats.lastRelayAt : 0,
    },
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
    ...(text(raw.ticketId) ? { ticketId: text(raw.ticketId) } : {}),
    ...(text(raw.staleReason) ? { staleReason: text(raw.staleReason) } : {}),
    ...(Number.isFinite(raw.staleAt) ? { staleAt: raw.staleAt } : {}),
  }
}

/**
 * Durable watch list plus the event-driven relay pipeline.
 *
 * Injected callbacks:
 *  - send(watch, text, event) -> Promise; must reject on delivery failure.
 *  - notify(message) -> void; Chatbot-visible notice.
 */
export class CoManagement {
  constructor({ stateDir, now = nowDefault, log = () => {}, send, notify, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, maxWatches = MAX_WATCHES } = {}) {
    if (!stateDir) throw new Error('CoManagement requires stateDir')
    this.stateDir = stateDir
    this.file = join(stateDir, CO_MANAGEMENT_FILE)
    this.now = now
    this.log = log
    this.send = typeof send === 'function' ? send : async () => {}
    this.notify = typeof notify === 'function' ? notify : () => {}
    this.retryDelaysMs = Array.isArray(retryDelaysMs) ? retryDelaysMs.filter(delay => Number.isFinite(delay) && delay >= 0).slice(0, 3) : DEFAULT_RETRY_DELAYS_MS.slice()
    this.maxWatches = maxWatches
    this.data = { version: 1, watches: [] }
    this.dedupe = new Map()
    this.buffers = new Map()
    this.rate = new Map()
    this.pendingQuestions = new Map()
    this.timers = new Set()
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const watches = Array.isArray(parsed && parsed.watches) ? parsed.watches : []
      this.data = { version: 1, watches: watches.map(normalizeWatch).filter(Boolean).slice(0, this.maxWatches) }
    } catch (error) {
      this.log('warn', 'could not read ' + this.file + ': ' + String(error && error.message ? error.message : error))
      this.data = { version: 1, watches: [] }
    }
  }

  save() {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const temp = this.file + '.tmp-' + process.pid
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(this.data, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.file)
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

  add({ sessionId, title, addedBy = 'chatbot', options, reason = '', ticketId = '' } = {}) {
    const id = String(sessionId || '')
    if (!id) return { ok: false, code: 'session_required', message: 'sessionId is required' }
    const existing = this.data.watches.find(item => item.sessionId === id && item.status !== 'revoked')
    if (existing) return { ok: true, watch: clone(existing), existing: true }
    if (this.data.watches.filter(item => item.status !== 'revoked').length >= this.maxWatches) {
      return { ok: false, code: 'watch_limit', message: 'at most ' + this.maxWatches + ' watched sessions' }
    }
    const watch = normalizeWatch({
      watchId: watchId(),
      sessionId: id,
      titleSnapshot: text(title) || id,
      addedAt: this.time(),
      addedBy,
      ...(text(reason) ? { reason: text(reason) } : {}),
      ...(text(ticketId) ? { ticketId: text(ticketId) } : {}),
      status: 'active',
      options,
      cursors: { lastRelayedSeq: 0, lastUserSeq: 0 },
      stats: { relayed: 0, suppressed: 0, lastRelayAt: 0 },
    })
    this.data.watches.push(watch)
    this.save()
    return { ok: true, watch: clone(watch), existing: false }
  }

  remove({ watchId: id, sessionId, all = false } = {}) {
    const before = this.data.watches.length
    if (all === true) this.data.watches = []
    else {
      const wantedId = text(id)
      const wantedSession = text(sessionId)
      if (!wantedId && !wantedSession) return { ok: false, code: 'target_required', message: 'watchId, sessionId or all is required' }
      this.data.watches = this.data.watches.filter(item => {
        if (wantedId && item.watchId === wantedId) return false
        if (wantedSession && item.sessionId === wantedSession) return false
        return true
      })
    }
    const removed = before - this.data.watches.length
    if (removed) this.save()
    return { ok: true, removed }
  }

  markStale(sessionId, reason = '会话已归档或不可用') {
    const watch = this.data.watches.find(item => item.sessionId === String(sessionId))
    if (!watch) return { ok: false, code: 'watch_missing' }
    if (watch.status === 'stale' && watch.staleReason) return { ok: true, watch: clone(watch), already: true }
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
