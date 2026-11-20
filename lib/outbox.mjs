// Durable outbox for user-visible side effects that must not be lost when no
// turn is active. Each entry is attempted at least once; transient failures
// back off and are retried, and exhausted entries stay as failed records so
// ria_status can explain what happened.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic as atomicWrite } from './shared/fs.mjs'

export const OUTBOX_VERSION = 1
export const OUTBOX_MAX_ATTEMPTS = 6
// 10s, 1m, 5m, 15m, 1h. The final value repeats after the list is exhausted.
export const OUTBOX_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 3_600_000]
export const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000
export const OUTBOX_MAX_ENTRIES = 500
export const OUTBOX_TICK_MS = 30_000
export const OUTBOX_STATUSES = ['pending', 'failed', 'delivered']
// A fallback copy of an assistant reply. Unlike notification notes it carries
// real content, so a resume must not fold it away.
export const WECHAT_ASSISTANT_NOTE_KIND = 'wechat_assistant_note'
// Side effects a user can see on a phone channel. Resume replay only touches
// these; internal host signals (queue wakes, dispatch cards for Ria's own turn)
// and queued file sends keep their normal retry behavior.
export const CHANNEL_BACKLOG_KINDS = Object.freeze([
  'wechat_dispatch_note',
  'wechat_approval_note',
  WECHAT_ASSISTANT_NOTE_KIND,
  'wechat_pause_notice',
  'channel_pause_notice',
  'wechat_fold_notice',
])

const CHANNEL_BACKLOG = new Set(CHANNEL_BACKLOG_KINDS)

const DEFAULT_LOG = () => {}

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
      let location = 'has been moved to ' + backup
      try {
        renameSync(this.file, backup)
      } catch (backupError) {
        location = 'was retained at ' + this.file + '; backup to ' + backup + ' failed: '
          + String(backupError && backupError.message ? backupError.message : backupError)
      }
      this.log('error', 'outbox was corrupt and ' + location + ': ' + String(error && error.message ? error.message : error))
      return
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : [])
    const stored = !Array.isArray(parsed) && parsed && parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {}
    this.stats = {
      folded: Number.isSafeInteger(stored.folded) && stored.folded >= 0 ? stored.folded : 0,
      lastFoldedAt: Number.isFinite(stored.lastFoldedAt) ? stored.lastFoldedAt : null,
    }
    this.entries = list.filter(isEntry).map(entry => {
      const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : this.now()
      return {
        ...entry,
        attempts: Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
        createdAt,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : this.now(),
        due: Number.isFinite(entry.due) ? entry.due : this.now(),
        // Entries written before eventAt existed fall back to their enqueue
        // time, which is the closest causal time available.
        eventAt: Number.isFinite(entry.eventAt) && entry.eventAt > 0 ? entry.eventAt : createdAt,
        ...(Number.isFinite(entry.replayOrder) ? { replayOrder: entry.replayOrder } : {}),
      }
    })
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
  enqueue({ kind, dedupeKey, payload, eventAt }) {
    const type = typeof kind === 'string' ? kind.trim() : ''
    if (!type) throw new Error('outbox entry requires a kind')
    if (!payload || typeof payload !== 'object') throw new Error('outbox entry requires a payload')
    const key = type + ':' + digest(dedupeKey === undefined ? payload : dedupeKey)
    const existing = this.entries.find(item => item.key === key)
    if (existing) return { entry: existing, created: false }
    const at = this.now()
    const happenedAt = Number.isFinite(eventAt) && eventAt > 0 ? eventAt : at
    const entry = {
      id: 'outbox_' + randomUUID().replace(/-/g, '').slice(0, 16),
      key,
      kind: type,
      payload,
      status: 'pending',
      attempts: 0,
      due: at,
      createdAt: at,
      // The event that caused this side effect. Retries and resume replays keep
      // it, so a backlog can be replayed in causal order instead of enqueue order.
      eventAt: happenedAt,
      updatedAt: at,
    }
    this.prune(at, { save: false })
    this.entries.push(entry)
    this.prune(at, { save: false })
    this.save()
    return { entry, created: true }
  }

  due(at = this.now()) {
    const rank = entry => Number.isFinite(entry.replayOrder) ? entry.replayOrder : Number.MAX_SAFE_INTEGER
    return this.entries
      .filter(entry => entry.status === 'pending' && Number.isFinite(entry.due) && entry.due <= at)
      .sort((a, b) => a.due - b.due || rank(a) - rank(b) || a.createdAt - b.createdAt)
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
   * Reconcile the phone-channel backlog when a channel resumes. Everything
   * caused at or before the last human message is marked delivered without
   * being sent: the user has already moved on. Everything after it is re-armed
   * in event-time order, so Ria's replies and the cards interleave exactly as
   * they happened. No summary banner is generated.
   *
   * Internal outbox signals and queued file sends are deliberately untouched:
   * suppressing them would lose work, not noise. Old fold banners are always
   * suppressed because that behavior no longer exists.
   */
  resumeChannelBacklog(anchor, at = this.now()) {
    const limit = Number.isFinite(anchor) && anchor > 0 ? anchor : 0
    let suppressed = 0
    const replay = []
    for (const entry of this.entries) {
      if (entry.status === 'delivered') continue
      if (!CHANNEL_BACKLOG.has(entry.kind)) continue
      const happenedAt = Number.isFinite(entry.eventAt) ? entry.eventAt : entry.createdAt
      if (entry.kind === 'wechat_fold_notice' || happenedAt <= limit) {
        entry.status = 'delivered'
        entry.deliveredAt = at
        entry.updatedAt = at
        entry.suppressedBy = 'resume'
        entry.suppressedAt = at
        delete entry.lastError
        delete entry.replayOrder
        suppressed += 1
      } else {
        replay.push({ entry, happenedAt })
      }
    }
    replay.sort((a, b) => a.happenedAt - b.happenedAt || a.entry.createdAt - b.entry.createdAt || String(a.entry.id).localeCompare(String(b.entry.id)))
    replay.forEach((item, index) => {
      item.entry.status = 'pending'
      item.entry.attempts = 0
      item.entry.due = at
      item.entry.replayOrder = index + 1
      item.entry.updatedAt = at
      delete item.entry.lastError
    })
    if (suppressed || replay.length) this.save()
    return { suppressed, replay: replay.length }
  }

  /**
   * Re-arm matching pending/failed entries without spending their retry budget.
   * Used when an inbound WeChat message refreshes the reply token: whatever
   * failed on the old token deserves one immediate attempt on the new one.
   */
  retryWhere(predicate, at = this.now()) {
    let changed = 0
    for (const entry of this.entries) {
      if (entry.status === 'delivered') continue
      if (!predicate(entry)) continue
      entry.status = 'pending'
      entry.attempts = 0
      entry.due = at
      entry.updatedAt = at
      delete entry.lastError
      changed += 1
    }
    if (changed) this.save()
    return changed
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
