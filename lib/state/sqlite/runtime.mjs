import { join } from 'node:path'
import { openDatabase } from './db.mjs'
import { SqliteTicketAdapter } from './adapter.mjs'

const STORAGE_MODES = new Set(['json', 'sqlite'])

/** storage=json is the default; DSH_RIA_STORAGE wins so an operator can switch
 * without editing the mirrored ria.json, and "storage" in the file survives a
 * process restart. */
export function resolveStorageMode({ env = process.env, state } = {}) {
  const fromEnv = String(env.DSH_RIA_STORAGE || '').toLowerCase()
  if (fromEnv) {
    if (!STORAGE_MODES.has(fromEnv)) throw Object.assign(new Error('Unknown DSH_RIA_STORAGE: ' + fromEnv + ' (expected json|sqlite)'), { code: 'storage_invalid' })
    return fromEnv
  }
  const fromState = String((state && state.storage) || '').toLowerCase()
  return STORAGE_MODES.has(fromState) ? fromState : 'json'
}

const signature = ticket => [ticket.revision ?? 0, Array.isArray(ticket.history) ? ticket.history.length : 0, ticket.updatedAt ?? 0].join(':')

/**
 * SQLite authority for tickets in storage=sqlite mode.
 *
 * The store keeps its in-memory ticket map (all ticket semantics stay in one
 * place), the runtime makes the DB the durable source: rows are hydrated at
 * boot, every committed write is upserted inside the writer transaction, and
 * the JSON file is only a debounced read-only mirror.
 */
export class SqliteTicketRuntime {
  constructor({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), exportMirror = null, debounceMs = 25 }) {
    this.stateDir = stateDir
    this.dbPath = dbPath
    this.exportMirror = exportMirror
    this.debounceMs = debounceMs
    this.db = openDatabase(dbPath, { readOnly: false, checkpoint: true })
    this.adapter = new SqliteTicketAdapter(this.db)
    this.persisted = new Map()
    this.timer = null
    this.dirty = false
    this.closed = false
    this.errors = []
  }

  /** Hot tickets, in the same shape the JSON store keeps in memory. */
  hotTickets() { return this.adapter.records({ includeArchived: false }).map(record => record.ticket) }

  /** Archived snapshots, newest first, as historyRecords() expects them. */
  archivedRecords() {
    return this.adapter.records({ includeArchived: true })
      .filter(record => record.archivedAt !== null)
      .map(record => ({ ticket: record.ticket, ticketId: record.ticket.ticketId, closedAt: record.closedAt || record.archivedAt, schema: 1 }))
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
  }

  /** Seed the signature map after boot so the first write only touches changes. */
  adopt(tickets) {
    this.persisted.clear()
    for (const ticket of tickets) this.persisted.set(ticket.ticketId, signature(ticket))
  }

  /** Upsert the tickets that actually changed. Caller owns the transaction. */
  persist(tickets) {
    let written = 0
    for (const ticket of tickets) {
      if (!ticket || typeof ticket.ticketId !== 'string') continue
      const next = signature(ticket)
      if (this.persisted.get(ticket.ticketId) === next) continue
      this.adapter.save(ticket)
      this.persisted.set(ticket.ticketId, next)
      written += 1
    }
    return written
  }

  archive(tickets, at = Date.now()) {
    for (const ticket of tickets) {
      this.adapter.save(ticket, { archivedAt: at })
      this.persisted.set(ticket.ticketId, signature(ticket))
    }
    return tickets.length
  }

  restore(ticketId) {
    const record = this.adapter.record(ticketId)
    if (!record) return undefined
    this.adapter.save(record.ticket, { archivedAt: null, meta: record.meta, archiveRecords: record.archiveRecords })
    this.persisted.set(record.ticket.ticketId, signature(record.ticket))
    return record.ticket
  }

  /** Mirror export runs after COMMIT, outside the writer queue, and coalesces. */
  scheduleMirror() {
    if (this.closed || !this.exportMirror) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.debounceMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty || !this.exportMirror) return false
    this.dirty = false
    this.exportMirror()
    return true
  }

  stats() { return { storage: 'sqlite', dbPath: this.dbPath, tickets: this.persisted.size, dirty: this.dirty, closed: this.closed } }

  close() {
    if (this.closed) return
    try { this.flush() } catch (cause) { this.errors.push(cause) }
    this.closed = true
    this.db.close()
  }
}
