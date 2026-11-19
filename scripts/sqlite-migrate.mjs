import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { readMigrationSource } from '../lib/state/sqlite/source.mjs'

// C1 offline skeleton. C3 adds backup, verification and publish-on-success.
export function migrateTickets({ stateDir, dbPath = join(stateDir, 'ria.sqlite') }) {
  if (existsSync(dbPath)) throw new Error('DB already exists; never overwrite an existing authoritative DB')
  const source = readMigrationSource(stateDir)
  const db = openDatabase(dbPath, { create: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    transaction(db, () => {
      for (const record of source.records) adapter.save(record.ticket, record)
      adapter.setSchemaMeta('import_id', source.importId)
      adapter.setSchemaMeta('source_sha256', source.sourceSha256)
    })
    return { ok: true, dbPath, counts: adapter.counts(), importId: source.importId }
  } finally { db.close() }
}

export function cliArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state-dir') result.stateDir = argv[++i]
    else if (arg === '--db') result.dbPath = argv[++i]
    else throw new Error('Unknown argument: ' + arg)
  }
  if (!result.stateDir) throw new Error('Usage: node scripts/sqlite-migrate.mjs --state-dir <offline-state-dir> [--db <path>]')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(migrateTickets(cliArgs(process.argv.slice(2))), null, 2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
