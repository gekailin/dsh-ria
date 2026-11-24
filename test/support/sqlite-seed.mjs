// Test-only helper: build a SQLite ticket DB from JSON state for runtime tests.
// The production one-shot importer has been removed; this fixture writes the
// same adapter records directly so runtime/schema/verify tests keep a real DB.
import { join } from 'node:path'
import { openDatabase, transaction } from '../../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../../lib/state/sqlite/adapter.mjs'
import { readStateSource } from '../../lib/state/sqlite/source.mjs'

export function seedSqliteFromState({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), extraRecords = [] }) {
  // The JSON fallback is intentional here: the DB does not exist yet, and
  // archived fixtures are supplied explicitly instead of via the retired log.
  const source = readStateSource(stateDir, { preferSqlite: false })
  const db = openDatabase(dbPath, { create: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    const records = [...source.records, ...extraRecords]
    transaction(db, () => {
      for (const record of records) {
        adapter.save(record.ticket, {
          meta: record.meta === undefined ? null : record.meta,
          archivedAt: record.archivedAt === undefined ? null : record.archivedAt,
          archiveRecords: record.archiveRecords || [],
        })
      }
      adapter.setSchemaMeta('import_id', source.importId)
      adapter.setSchemaMeta('source_sha256', source.sourceSha256)
      adapter.setSchemaMeta('imported_at', String(Date.now()))
    })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const extra = extraRecords.reduce((acc, record) => {
      acc.tickets += 1
      acc.archived += 1
      acc.history += Array.isArray(record.ticket && record.ticket.history) ? record.ticket.history.length : 0
      return acc
    }, { tickets: 0, archived: 0, history: 0 })
    return { ok: true, mode: 'seeded', dbPath, counts: {
      ...source.counts,
      tickets: source.counts.tickets + extra.tickets,
      archived: source.counts.archived + extra.archived,
      history: source.counts.history + extra.history,
    } }
  } finally {
    db.close()
  }
}
