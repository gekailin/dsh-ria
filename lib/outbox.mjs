// Durable outbox for user-visible side effects that must not be lost when no
// turn is active. Each entry is attempted at least once; transient failures
// back off and are retried, and exhausted entries stay as failed records so
// ria_status can explain what happened.

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export const OUTBOX_VERSION = 1
export const OUTBOX_MAX_ATTEMPTS = 6
// 10s, 1m, 5m, 15m, 1h. The final value repeats after the list is exhausted.
export const OUTBOX_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 3_600_000]
export const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000
export const OUTBOX_MAX_ENTRIES = 500
export const OUTBOX_TICK_MS = 30_000
export const OUTBOX_STATUSES = ['pending', 'failed', 'delivered']

const DEFAULT_LOG = () => {}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicWrite(file, text) {
  ensureDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = stableValue(value[key])
  }
  return result
}

function digest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(stableValue(value))
  return createHash('sha256').update(text).digest('hex').slice(0, 20)
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value)
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit).join('') : text
}

function isEntry(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && typeof value.key === 'string' &&
    typeof value.kind === 'string' && OUTBOX_STATUSES.includes(value.status) && value.payload && typeof value.payload === 'object')
}

/**
 * A small JSON-backed queue. It owns its own atomic persistence so it can be
 * constructed before the rest of the plugin and reloaded independently.
 */
export class Outbox {
  constructor(file, options = {}) {
    this.file = file
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.log = typeof options.log === 'function' ? options.log : DEFAULT_LOG
    this.entries = []
    this.stats = { folded: 0, lastFoldedAt: null }
    this.loaded = false
    this.load()
  }

  load() {
    this.loaded = true
    if (!existsSync(this.file)) return
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      this.log('warn', 'could not read outbox: ' + String(error && error.message ? error.message : error))
      return
    }
    if (!raw.trim()) return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const backup = this.file + '.corrupt-' + this.now()
      try { renameSync(this.file, backup) } catch { /* keep the original when the rename fails */ }
      this.log('error', 'outbox was corrupt and has been moved to ' + backup + ': ' + String(error && error.message ? error.message : error))
      return
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : [])
    const stored = !Array.isArray(parsed) && parsed && parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {}
    this.stats = {
      folded: Number.isSafeInteger(stored.folded) && stored.folded >= 0 ? stored.folded : 0,
      lastFoldedAt: Number.isFinite(stored.lastFoldedAt) ? stored.lastFoldedAt : null,
    }
    this.entries = list.filter(isEntry).map(entry => ({
      ...entry,
      attempts: Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : this.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : this.now(),
      due: Number.isFinite(entry.due) ? entry.due : this.now(),
    }))
  }

  save() {
    atomicWrite(this.file, JSON.stringify({ version: OUTBOX_VERSION, stats: this.stats, entries: this.entries }, null, 2) + '\n')
  }

  /** Cumulative fold counters survive restarts; they are not per-queue-size. */
  outboxStats() {
    return { folded: this.stats.folded, lastFoldedAt: this.stats.lastFoldedAt }
  }

  entry(id) {
    return this.entries.find(item => item.id === id)
  }

  all() {
    return this.entries.slice()
  }

  /**
   * Enqueue one side effect. dedupeKey must be stable across retries of the same
   * logical effect (for dispatch notes the noteId is the natural key).
   */
  enqueue({ kind, dedupeKey, payload }) {
    const type = typeof kind === 'string' ? kind.trim() : ''
    if (!type) throw new Error('outbox entry requires a kind')
    if (!payload || typeof payload !== 'object') throw new Error('outbox entry requires a payload')
    const key = type + ':' + digest(dedupeKey === undefined ? payload : dedupeKey)
    const existing = this.entries.find(item => item.key === key)
    if (existing) return { entry: existing, created: false }
    const at = this.now()
    const entry = {
      id: 'outbox_' + randomUUID().replace(/-/g, '').slice(0, 16),
      key,
      kind: type,
      payload,
      status: 'pending',
      attempts: 0,
      due: at,
      createdAt: at,
      updatedAt: at,
    }
    this.prune(at, { save: false })
    this.entries.push(entry)
    this.prune(at, { save: false })
    this.save()
    return { entry, created: true }
  }

  due(at = this.now()) {
    return this.entries
      .filter(entry => entry.status === 'pending' && Number.isFinite(entry.due) && entry.due <= at)
      .sort((a, b) => a.due - b.due || a.createdAt - b.createdAt)
  }

  /**
   * Drop entries matching a predicate. Used to invalidate a queued wake when its
   * ticket stopped being ready before the wake was delivered.
   */
  removeWhere(predicate) {
    if (typeof predicate !== 'function') return 0
    const before = this.entries.length
    this.entries = this.entries.filter(entry => !predicate(entry))
    const removed = before - this.entries.length
    if (removed) this.save()
    return removed
  }

  markDelivered(id, at = this.now()) {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.status = 'delivered'
    entry.deliveredAt = at
    entry.updatedAt = at
    delete entry.lastError
    this.save()
    return entry
  }

  /** Record one failed attempt; return the updated entry and whether it is terminal. */
  markFailed(id, error, at = this.now()) {
    const entry = this.entry(id)
    if (!entry) return undefined
    const message = clip(error && error.message ? error.message : error, 500)
    entry.attempts += 1
    entry.lastError = message
    entry.updatedAt = at
    if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
      entry.status = 'failed'
      entry.due = at
    } else {
      const delay = OUTBOX_RETRY_DELAYS_MS[Math.min(entry.attempts - 1, OUTBOX_RETRY_DELAYS_MS.length - 1)]
      entry.status = 'pending'
      entry.due = at + delay
    }
    this.save()
    return entry
  }

  /**
   * Fold WeChat notifications created before a resume. They are marked delivered
   * without being sent, so the user gets one summary instead of a replay. The
   * fold summary itself is excluded: it must still reach the channel.
   */
  foldOlderWechat(cutoff, at = this.now()) {
    const limit = Number.isFinite(cutoff) ? cutoff : at
    let folded = 0
    for (const entry of this.entries) {
      if (entry.status === 'delivered') continue
      if (!entry.kind.startsWith('wechat_') || entry.kind === 'wechat_fold_notice') continue
      if (!Number.isFinite(entry.createdAt) || entry.createdAt >= limit) continue
      entry.status = 'delivered'
      entry.deliveredAt = at
      entry.updatedAt = at
      entry.folded = true
      entry.foldedAt = at
      delete entry.lastError
      folded += 1
    }
    if (!folded) return 0
    this.stats.folded += folded
    this.stats.lastFoldedAt = at
    this.save()
    return folded
  }

  /** Keep delivered records for a day, then drop the oldest if the queue is too big. */
  prune(at = this.now(), options = {}) {
    const before = this.entries.length
    this.entries = this.entries.filter(entry => {
      if (entry.status !== 'delivered') return true
      const deliveredAt = Number.isFinite(entry.deliveredAt) ? entry.deliveredAt : entry.updatedAt
      return at - deliveredAt <= OUTBOX_RETENTION_MS
    })
    let over = this.entries.length - OUTBOX_MAX_ENTRIES
    if (over > 0) {
      const removable = this.entries
        .filter(entry => entry.status === 'delivered')
        .sort((a, b) => (a.deliveredAt || a.updatedAt) - (b.deliveredAt || b.updatedAt))
      while (over > 0 && removable.length) {
        const victim = removable.shift()
        const index = this.entries.indexOf(victim)
        if (index >= 0) this.entries.splice(index, 1)
        over -= 1
      }
    }
    if (over > 0) {
      const failed = this.entries
        .filter(entry => entry.status === 'failed')
        .sort((a, b) => a.updatedAt - b.updatedAt)
      while (over > 0 && failed.length) {
        const victim = failed.shift()
        const index = this.entries.indexOf(victim)
        if (index >= 0) this.entries.splice(index, 1)
        this.log('warn', 'outbox is over its entry limit; dropped failed entry ' + victim.id + ' (' + victim.kind + ')')
        over -= 1
      }
    }
    if (over > 0) {
      this.log('warn', 'outbox still has ' + this.entries.length + ' entries after pruning; ' + over + ' pending entries were kept')
    }
    const changed = before !== this.entries.length
    if (changed && options.save !== false) this.save()
    return changed
  }

  summary({ ticketId, limit = 20 } = {}) {
    const scoped = ticketId
      ? this.entries.filter(entry => entry.payload && entry.payload.ticketId === ticketId)
      : this.entries
    const counts = { pending: 0, failed: 0, delivered: 0, total: scoped.length }
    for (const entry of scoped) {
      if (counts[entry.status] !== undefined) counts[entry.status] += 1
    }
    const items = scoped
      .filter(entry => entry.status !== 'delivered')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(entry => {
        const item = {
          id: entry.id,
          kind: entry.kind,
          status: entry.status,
          attempts: entry.attempts,
          due: entry.due,
          updatedAt: entry.updatedAt,
        }
        if (entry.payload && typeof entry.payload.ticketId === 'string' && entry.payload.ticketId) item.ticketId = entry.payload.ticketId
        if (entry.lastError) item.lastError = entry.lastError
        if (entry.payload && typeof entry.payload.note === 'string') item.note = clip(entry.payload.note, 120)
        return item
      })
    return { ...counts, folded: this.stats.folded, lastFoldedAt: this.stats.lastFoldedAt, items }
  }
}
