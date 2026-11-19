import { isDeepStrictEqual } from 'node:util'

const json = value => JSON.stringify(value === undefined ? null : value)
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const fail = (code, message) => Object.assign(new Error(message), { code })
const CORE = {
  ticketId: 'id', status: 'status', waitingOn: 'waiting_on', executor: 'executor',
  goal: 'goal', acceptance: 'acceptance', revision: 'revision',
  createdAt: 'created_at', updatedAt: 'updated_at', closedAt: 'closed_at',
}

export function ticketToRow(ticket, { meta = null, archivedAt = null, archiveRecords = [] } = {}) {
  if (!ticket || typeof ticket.ticketId !== 'string' || !ticket.ticketId) throw fail('invalid_ticket', 'ticketId is required')
  const extra = clone(ticket)
  delete extra.history
  for (const name of Object.keys(CORE)) delete extra[name]
  delete extra.attempt
  delete extra.failure
  delete extra.resolution
  return {
    id: ticket.ticketId, status: ticket.status, waiting_on: ticket.waitingOn ?? null,
    executor: ticket.executor ?? null, goal: ticket.goal || '', acceptance: ticket.acceptance || '',
    revision: ticket.revision ?? 1, created_at: ticket.createdAt ?? 0, updated_at: ticket.updatedAt ?? 0,
    closed_at: ticket.closedAt ?? null, phase: meta?.phase ?? null, project_cwd: meta?.projectCwd ?? null,
    attempt_json: json(ticket.attempt), failure_json: json(ticket.failure), resolution_json: json(ticket.resolution),
    meta: json({ ticket: extra, fields: Object.keys(ticket), v2: clone(meta), archiveRecords: clone(archiveRecords) }),
    archived_at: archivedAt,
  }
}

export function rowToTicket(row, history = []) {
  if (!row) return undefined
  const envelope = JSON.parse(row.meta)
  const ticket = { ...envelope.ticket }
  const fields = new Set(envelope.fields || [])
  for (const [name, column] of Object.entries(CORE)) {
    if (fields.has(name)) ticket[name] = row[column]
  }
  for (const [name, column] of [['attempt', 'attempt_json'], ['failure', 'failure_json'], ['resolution', 'resolution_json']]) {
    if (fields.has(name)) ticket[name] = JSON.parse(row[column])
  }
  if (fields.has('history') || history.length) ticket.history = history
  return ticket
}

/** SQL stays here. Caller owns the short synchronous transaction. */
export class SqliteTicketAdapter {
  constructor(db, { reader = db } = {}) {
    this.db = db
    this.reader = reader
  }

  history(ticketId) {
    return this.reader.prepare('SELECT payload_json FROM ticket_history WHERE ticket_id=? ORDER BY seq').all(ticketId)
      .map(row => JSON.parse(row.payload_json))
  }

  record(ticketId) {
    const row = this.reader.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId)
    if (!row) return undefined
    const envelope = JSON.parse(row.meta)
    return { ticket: rowToTicket(row, this.history(ticketId)), meta: envelope.v2,
      archivedAt: row.archived_at, archiveRecords: envelope.archiveRecords || [] }
  }

  get(ticketId, { includeArchived = false } = {}) {
    const record = this.record(ticketId)
    return record && (includeArchived || record.archivedAt === null) ? record.ticket : undefined
  }

  records({ includeArchived = true } = {}) {
    const rows = this.reader.prepare('SELECT id FROM tickets' + (includeArchived ? '' : ' WHERE archived_at IS NULL') + ' ORDER BY created_at, id').all()
    return rows.map(row => this.record(row.id))
  }

  list(options = {}) { return this.records({ includeArchived: false, ...options }).map(record => record.ticket) }

  counts() {
    const tickets = Number(this.reader.prepare('SELECT COUNT(*) n FROM tickets').get().n)
    const history = Number(this.reader.prepare('SELECT COUNT(*) n FROM ticket_history').get().n)
    const hot = Number(this.reader.prepare('SELECT COUNT(*) n FROM tickets WHERE archived_at IS NULL').get().n)
    const meta = Number(this.reader.prepare("SELECT COUNT(*) n FROM tickets WHERE json_type(meta,'$.v2')='object'").get().n)
    return { tickets, history, hot, archived: tickets - hot, meta }
  }

  setSchemaMeta(key, value) {
    this.db.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(key, typeof value === 'string' ? value : json(value), Date.now())
  }

  getSchemaMeta(key) { return this.reader.prepare('SELECT value FROM schema_meta WHERE key=?').get(key)?.value }

  save(ticket, options = {}) {
    const previousRow = this.db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.ticketId)
    if (options.expectedRevision !== undefined && previousRow?.revision !== options.expectedRevision) {
      throw fail('stale_revision', 'ticket ' + ticket.ticketId + ' changed since revision ' + options.expectedRevision)
    }
    const previousEnvelope = previousRow ? JSON.parse(previousRow.meta) : null
    const row = ticketToRow(ticket, {
      meta: options.meta === undefined ? previousEnvelope?.v2 ?? null : options.meta,
      archivedAt: options.archivedAt === undefined ? previousRow?.archived_at ?? null : options.archivedAt,
      archiveRecords: options.archiveRecords === undefined ? previousEnvelope?.archiveRecords || [] : options.archiveRecords,
    })
    const previousHistory = this.db.prepare('SELECT payload_json FROM ticket_history WHERE ticket_id=? ORDER BY seq').all(ticket.ticketId).map(entry => JSON.parse(entry.payload_json))
    const history = Array.isArray(ticket.history) ? ticket.history : []
    if (history.length < previousHistory.length || previousHistory.some((entry, index) => !isDeepStrictEqual(entry, history[index]))) {
      throw fail('history_not_append_only', 'ticket ' + ticket.ticketId + ' tried to rewrite committed history')
    }
    const columns = Object.keys(row)
    this.db.prepare('INSERT INTO tickets(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ') ON CONFLICT(id) DO UPDATE SET '
      + columns.filter(column => column !== 'id').map(column => column + '=excluded.' + column).join(','))
      .run(...columns.map(column => row[column]))
    const insert = this.db.prepare('INSERT INTO ticket_history(ticket_id,seq,at,from_status,to_status,actor,reason,kind,payload_json) VALUES(?,?,?,?,?,?,?,?,?)')
    for (let seq = previousHistory.length; seq < history.length; seq += 1) {
      const entry = history[seq]
      insert.run(ticket.ticketId, seq, Number.isFinite(entry.at) ? entry.at : ticket.createdAt ?? 0,
        entry.from ?? null, entry.to ?? null, entry.actor ?? null, entry.reason ?? null, entry.kind ?? null, json(entry))
    }
    return ticket
  }

  setMeta(ticketId, patch, options = {}) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId)
    if (!row) throw fail('ticket_missing', 'ticket not found: ' + ticketId)
    const envelope = JSON.parse(row.meta)
    const meta = { ...(envelope.v2 || { ticketId, scope: 'global', projectId: null, createdAt: Date.now() }), ...clone(patch), updatedAt: Date.now() }
    const ticket = rowToTicket(row, this.db.prepare('SELECT payload_json FROM ticket_history WHERE ticket_id=? ORDER BY seq').all(ticketId).map(entry => JSON.parse(entry.payload_json)))
    this.save(ticket, { ...options, meta })
    return meta
  }
}
