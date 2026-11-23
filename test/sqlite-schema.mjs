import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { seedSqliteFromState } from './support/sqlite-seed.mjs'
import { exportTickets } from '../scripts/sqlite-export.mjs'

const stateDir = mkdtempSync(join(tmpdir(), 'ria-sqlite-schema-'))
const ticket = {
  ticketId: 'ticket_one', status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'round trip',
  acceptance: 'unchanged', revision: 1, createdAt: 100, updatedAt: 100, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null,
  checklist: [{ text: 'keep unknown fields', done: false }], custom: { nested: ['a', 2] },
  history: [{ at: 100, actor: 'router', from: 'intake', to: 'open', reason: 'route', custom: 'preserved' }],
}
const meta = { ticketId: ticket.ticketId, scope: 'global', phase: 'advisor', projectCwd: '/tmp/project', mode: 'work' }
const archived = { ...ticket, ticketId: 'ticket_archive', status: 'done', closedAt: 200, resolution: { summary: 'done' } }
try {
  writeFileSync(join(stateDir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [ticket], settings: { keep: true }, grants: ['leave-json'] }))
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ tickets: { [ticket.ticketId]: meta }, reports: ['leave-json'], workOrders: { keep: true } }))
  const archive = { ticket: archived, ticketId: archived.ticketId, closedAt: archived.closedAt, schema: 1 }
  writeFileSync(join(stateDir, 'tickets.log.jsonl'), JSON.stringify(archive) + '\n')
  writeFileSync(join(stateDir, 'tickets-2026-11.jsonl'), JSON.stringify(archive) + '\n')
  const before = readFileSync(join(stateDir, 'ria.json'), 'utf8')
  const seeded = seedSqliteFromState({ stateDir })
  assert.equal(seeded.ok, true)
  assert.deepEqual(seeded.counts, { tickets: 2, history: 2, hot: 1, archived: 1, meta: null })
  const exported = exportTickets({ stateDir })
  assert.deepEqual(exported.ria.tickets, [ticket])
  assert.deepEqual(exported.state.tickets[ticket.ticketId], meta)
  assert.deepEqual(exported.ria.settings, { keep: true })
  assert.deepEqual(exported.state.reports, ['leave-json'])
  assert.deepEqual(exported.archives, [archive])
  assert.equal(readFileSync(join(stateDir, 'ria.json'), 'utf8'), before)

  const dbPath = join(stateDir, 'ria.sqlite')
  let db = openDatabase(dbPath)
  let adapter = new SqliteTicketAdapter(db)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1)
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  assert.deepEqual(adapter.get(ticket.ticketId), ticket)
  assert.equal(adapter.get(archived.ticketId), undefined)
  assert.deepEqual(adapter.get(archived.ticketId, { includeArchived: true }), archived)
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().some(row => row.name === 'idx_ticket_history_ticket_at'))

  const updated = { ...ticket, revision: 2, goal: 'committed', history: [...ticket.history, { at: 101, actor: 'executor', reason: 'next' }] }
  assert.throws(() => transaction(db, () => { adapter.save(updated); throw new Error('rollback probe') }), /rollback probe/)
  assert.deepEqual(adapter.get(ticket.ticketId), ticket)
  assert.equal(adapter.history(ticket.ticketId).length, 1)
  assert.throws(() => transaction(db, async () => {}), { code: 'async_transaction' })
  assert.throws(() => transaction(db, () => adapter.save(updated, { expectedRevision: 9 })), { code: 'stale_revision' })
  transaction(db, () => adapter.save(updated, { expectedRevision: 1 }))
  assert.throws(() => transaction(db, () => adapter.save({ ...updated, history: [] })), { code: 'history_not_append_only' })
  assert.throws(() => db.exec("UPDATE ticket_history SET actor='rewritten' WHERE ticket_id='ticket_one'"), /append-only/)
  assert.throws(() => db.exec("DELETE FROM ticket_history WHERE ticket_id='ticket_one'"), /append-only/)
  db.close()
  db = openDatabase(dbPath)
  adapter = new SqliteTicketAdapter(db)
  assert.equal(adapter.get(ticket.ticketId).goal, 'committed')
  assert.equal(adapter.history(ticket.ticketId).length, 2)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
  assert.throws(() => openDatabase(join(stateDir, 'missing.sqlite')), { code: 'sqlite_missing' })
  console.log('sqlite schema and offline round trip ok')
} finally { rmSync(stateDir, { recursive: true, force: true }) }
