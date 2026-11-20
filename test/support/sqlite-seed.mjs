// Test-only helper: build a SQLite ticket DB from JSON state for runtime tests.
// The production one-shot importer has been removed; this fixture writes the
// same adapter records directly so runtime/schema/verify tests keep a real DB.
import { join } from 'node:path'
import { openDatabase, transaction } from '../../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../../lib/state/sqlite/adapter.mjs'
import { readStateSource } from '../../lib/state/sqlite/source.mjs'

export function seedSqliteFromState({ stateDir, dbPath = join(stateDir, 'ria.sqlite') }) {
  const source = readStateSource(stateDir)
  const db = openDatabase(dbPath, { create: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    transaction(db, () => {
      for (const record of source.records) adapter.save(record.ticket, record)
      adapter.setSchemaMeta('import_id', source.importId)
      adapter.setSchemaMeta('source_sha256', source.sourceSha256)
      adapter.setSchemaMeta('imported_at', String(Date.now()))
    })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { ok: true, mode: 'seeded', dbPath, counts: source.counts }
  } finally {
    db.close()
  }
}
