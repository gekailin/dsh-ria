// SQLite persistence for execution state previously stored in events.jsonl:
// work_orders, ticket_reports, executor_inbox, ticket_requests, ticket_feedback.
import { EventLog } from '../event-log.mjs'

const json = value => JSON.stringify(value)
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const idOf = (item, ...keys) => {
  if (!item || typeof item !== 'object') return ''
  for (const key of keys) {
    if (item[key] != null && String(item[key]).trim()) return String(item[key])
  }
  return ''
}

export const EVENTS_SQLITE_IMPORT_MARKER = 'events_jsonl_imported_v1'

export function loadTicketFeedback(db) {
  const ticketFeedback = []
  for (const row of db.prepare('SELECT payload_json FROM ticket_feedback ORDER BY at ASC, id ASC').all()) {
    try { ticketFeedback.push(JSON.parse(row.payload_json)) } catch { /* skip corrupt */ }
  }
  return ticketFeedback
}

export function syncTicketFeedback(db, next = [], previous = null) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  syncArrayTable({
    db,
    prev: previous,
    next: Array.isArray(next) ? next : [],
    keyOf: (item, idx) => idOf(item, 'feedbackId', 'id') || ('fb_' + idx + '_' + num(item?.at, 0)),
    upsertSql: 'INSERT INTO ticket_feedback(id,ticket_id,at,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,at=excluded.at,payload_json=excluded.payload_json',
    deleteSql: 'DELETE FROM ticket_feedback WHERE id=?',
    paramsOf: (id, item) => [id, item?.ticketId ? String(item.ticketId) : null, num(item?.at || item?.createdAt, Date.now()), json(item)],
    same,
  })
}

export function loadExecutionState(db) {
  const workOrders = {}
  for (const row of db.prepare('SELECT ticket_id, payload_json FROM work_orders ORDER BY updated_at ASC, ticket_id ASC').all()) {
    try { workOrders[row.ticket_id] = JSON.parse(row.payload_json) } catch { /* skip corrupt */ }
  }
  const requests = {}
  for (const row of db.prepare('SELECT id, payload_json FROM ticket_requests ORDER BY created_at ASC, id ASC').all()) {
    try { requests[row.id] = JSON.parse(row.payload_json) } catch { /* skip corrupt */ }
  }
  const reports = []
  for (const row of db.prepare('SELECT payload_json FROM ticket_reports ORDER BY at ASC, id ASC').all()) {
    try { reports.push(JSON.parse(row.payload_json)) } catch { /* skip corrupt */ }
  }
  const inbox = []
  for (const row of db.prepare('SELECT payload_json FROM executor_inbox ORDER BY at ASC, id ASC').all()) {
    try { inbox.push(JSON.parse(row.payload_json)) } catch { /* skip corrupt */ }
  }
  const ticketFeedback = loadTicketFeedback(db)
  return { workOrders, requests, reports, inbox, ticketFeedback }
}

export function syncExecutionState(db, data, previous = null) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // work_orders
  const prevWork = previous?.workOrders || {}
  const nextWork = data?.workOrders || {}
  const upsertWork = db.prepare('INSERT INTO work_orders(ticket_id,updated_at,payload_json) VALUES(?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json')
  const deleteWork = db.prepare('DELETE FROM work_orders WHERE ticket_id=?')
  for (const [ticketId, item] of Object.entries(nextWork)) {
    if (!previous || !same(prevWork[ticketId], item)) {
      upsertWork.run(String(ticketId), num(item?.updatedAt || item?.at || item?.createdAt, Date.now()), json(item))
    }
  }
  if (previous) {
    for (const ticketId of Object.keys(prevWork)) {
      if (!Object.hasOwn(nextWork, ticketId)) deleteWork.run(String(ticketId))
    }
  }

  // ticket_requests
  const prevReq = previous?.requests || {}
  const nextReq = data?.requests || {}
  const upsertReq = db.prepare('INSERT INTO ticket_requests(id,ticket_id,created_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,created_at=excluded.created_at,payload_json=excluded.payload_json')
  const deleteReq = db.prepare('DELETE FROM ticket_requests WHERE id=?')
  for (const [id, item] of Object.entries(nextReq)) {
    if (!previous || !same(prevReq[id], item)) {
      upsertReq.run(String(id), item?.ticketId ? String(item.ticketId) : null, num(item?.createdAt || item?.at, Date.now()), json(item))
    }
  }
  if (previous) {
    for (const id of Object.keys(prevReq)) {
      if (!Object.hasOwn(nextReq, id)) deleteReq.run(String(id))
    }
  }

  // ticket_reports
  syncArrayTable({
    db,
    prev: previous?.reports,
    next: data?.reports || [],
    keyOf: (item, idx) => idOf(item, 'reportId', 'id') || ('rep_' + idx + '_' + num(item?.at, 0)),
    upsertSql: 'INSERT INTO ticket_reports(id,ticket_id,at,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,at=excluded.at,payload_json=excluded.payload_json',
    deleteSql: 'DELETE FROM ticket_reports WHERE id=?',
    paramsOf: (id, item) => [id, item?.ticketId ? String(item.ticketId) : null, num(item?.at || item?.createdAt, Date.now()), json(item)],
    same,
  })

  // executor_inbox
  syncArrayTable({
    db,
    prev: previous?.inbox,
    next: data?.inbox || [],
    keyOf: (item, idx) => idOf(item, 'id') || ('in_' + idx + '_' + num(item?.at, 0)),
    upsertSql: 'INSERT INTO executor_inbox(id,ticket_id,executor_id,delivered_at,discarded_at,at,payload_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,executor_id=excluded.executor_id,delivered_at=excluded.delivered_at,discarded_at=excluded.discarded_at,at=excluded.at,payload_json=excluded.payload_json',
    deleteSql: 'DELETE FROM executor_inbox WHERE id=?',
    paramsOf: (id, item) => [
      id,
      item?.ticketId ? String(item.ticketId) : null,
      item?.executorId ? String(item.executorId) : null,
      item?.deliveredAt != null ? num(item.deliveredAt, null) : null,
      item?.discardedAt != null ? num(item.discardedAt, null) : null,
      num(item?.at || item?.createdAt, Date.now()),
      json(item),
    ],
    same,
  })

  // ticket_feedback (only when explicitly requested; RiaStore owns ticketFeedback in live runtime)
  if (data && Object.hasOwn(data, 'ticketFeedback')) {
    syncTicketFeedback(db, data.ticketFeedback, previous?.ticketFeedback ?? null)
  }
}

function syncArrayTable({ db, prev, next, keyOf, upsertSql, deleteSql, paramsOf, same }) {
  const prevMap = prev ? new Map(prev.map((item, idx) => [keyOf(item, idx), item])) : null
  const nextKeys = new Set()
  const upsert = db.prepare(upsertSql)
  for (let i = 0; i < next.length; i += 1) {
    const item = next[i]
    const id = keyOf(item, i)
    nextKeys.add(id)
    if (!prevMap || !same(prevMap.get(id), item)) {
      upsert.run(...paramsOf(id, item))
    }
  }
  if (prevMap) {
    const del = db.prepare(deleteSql)
    for (const id of prevMap.keys()) {
      if (!nextKeys.has(id)) del.run(id)
    }
  }
}

/**
 * One-shot import of legacy events.jsonl into the 5 execution tables.
 * Idempotent via schema_meta marker; does not delete events.jsonl.
 */
export function importLegacyEventsJsonl({ db, stateDir, warn = () => {} } = {}) {
  const marker = db.prepare('SELECT value FROM schema_meta WHERE key=?').get(EVENTS_SQLITE_IMPORT_MARKER)
  if (marker) return { skipped: true }
  const log = new EventLog({ stateDir, warn })
  if (!log.hasEvents()) {
    db.prepare('INSERT OR REPLACE INTO schema_meta(key,value,updated_at) VALUES(?,?,?)')
      .run(EVENTS_SQLITE_IMPORT_MARKER, JSON.stringify({ at: Date.now(), imported: 0 }), Date.now())
    return { skipped: false, imported: 0 }
  }
  const { data } = log.rebuild({ requests: Infinity, reports: Infinity, workOrders: Infinity, ticketFeedback: Infinity, inbox: Infinity })
  syncExecutionState(db, data, null)
  const counts = {
    workOrders: Object.keys(data.workOrders || {}).length,
    requests: Object.keys(data.requests || {}).length,
    reports: (data.reports || []).length,
    inbox: (data.inbox || []).length,
    ticketFeedback: (data.ticketFeedback || []).length,
  }
  db.prepare('INSERT OR REPLACE INTO schema_meta(key,value,updated_at) VALUES(?,?,?)')
    .run(EVENTS_SQLITE_IMPORT_MARKER, JSON.stringify({ at: Date.now(), counts }), Date.now())
  return { skipped: false, counts }
}
