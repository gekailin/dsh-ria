import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { inspectArchiveRecords, cleanupArchiveRecords, rollbackArchiveRecords } from '../lib/state/sqlite/archive-records.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-archive-cleanup-'))
const dbPath = join(root, 'ria.sqlite')
const ticket = (id, archivedAt = null) => ({
  ticketId: id, status: archivedAt ? 'done' : 'open', waitingOn: archivedAt ? 'none' : 'ria',
  executor: 'executor', goal: 'goal ' + id, acceptance: 'accept', revision: 1,
  createdAt: 1, updatedAt: 2, closedAt: archivedAt || null, attempt: { legacy: true },
  failure: null, resolution: archivedAt ? { summary: 'done' } : null, history: [],
})
try {
  const db = openDatabase(dbPath, { create: true })
  const adapter = new SqliteTicketAdapter(db)
  adapter.save(ticket('t1', 10), { meta: { phase: 'advisor' }, archivedAt: 10 })
  adapter.save(ticket('t2'), { meta: { phase: 'advisor' } })
  const t1Row = JSON.parse(db.prepare("SELECT meta FROM tickets WHERE id='t1'").get().meta)
  assert.equal(Object.hasOwn(t1Row, 'archiveRecords'), false, 'archive write must not embed a whole ticket in meta')
  assert.equal(adapter.record('t1').archiveRecords.length, 1, 'archived view is derived from the ticket row')
  db.prepare("UPDATE tickets SET meta=json_set(meta,'$.archiveRecords',json(?)) WHERE id='t1'")
    .run(JSON.stringify([{ ticketId: 't1', closedAt: 10, schema: 1, ticket: ticket('t1', 10) }]))
  const before = inspectArchiveRecords(db)
  assert.equal(before.rows, 1)
  const dry = cleanupArchiveRecords(db, { stateDir: root, apply: false })
  assert.equal(dry.applied, false)
  assert.deepEqual(inspectArchiveRecords(db), before)

  const applied = cleanupArchiveRecords(db, { stateDir: root, apply: true, now: 123 })
  assert.equal(applied.ok, true)
  assert.equal(applied.applied, true)
  assert.equal(applied.tickets, 1)
  assert.ok(existsSync(applied.journal))
  assert.equal(inspectArchiveRecords(db).rows, 0)
  const meta = JSON.parse(db.prepare("SELECT meta FROM tickets WHERE id='t1'").get().meta)
  assert.equal(Object.hasOwn(meta, 'archiveRecords'), false)
  assert.equal(meta.state.phase, 'advisor')
  const again = cleanupArchiveRecords(db, { stateDir: root, apply: true, now: 124 })
  assert.equal(again.applied, false)
  assert.equal(readFileSync(applied.journal, 'utf8').includes('"archiveRecords"'), true)

  const rolled = rollbackArchiveRecords(db, { stateDir: root, runId: applied.runId })
  assert.equal(rolled.ok, true)
  assert.equal(rolled.restored, 1)
  assert.equal(inspectArchiveRecords(db).rows, 1)
  const restored = JSON.parse(db.prepare("SELECT meta FROM tickets WHERE id='t1'").get().meta)
  assert.equal(restored.archiveRecords[0].ticketId, 't1')
  assert.equal(existsSync(applied.journal), false)
  assert.equal(rollbackArchiveRecords(db, { stateDir: root }).code, 'archive_cleanup_missing')
  db.close()
  console.log('archive records cleanup and rollback ok')
} finally { rmSync(root, { recursive: true, force: true }) }
