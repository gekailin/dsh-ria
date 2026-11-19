import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'

export function exportTickets({ stateDir, dbPath = join(stateDir, 'ria.sqlite') }) {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    const read = (name, fallback) => existsSync(join(stateDir, name)) ? JSON.parse(readFileSync(join(stateDir, name), 'utf8')) : fallback
    const ria = read('ria.json', { schemaVersion: 5, version: 5 })
    const v2 = read('v2.json', {})
    const records = adapter.records()
    ria.tickets = records.filter(record => record.archivedAt === null).map(record => record.ticket)
    v2.tickets = Object.fromEntries(records.filter(record => record.meta !== null).map(record => [record.ticket.ticketId, record.meta]))
    return { ria, v2, archives: records.flatMap(record => record.archiveRecords), counts: adapter.counts() }
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args[0] !== '--state-dir' || !args[1] || args.length !== 2) throw new Error('Usage: node scripts/sqlite-export.mjs --state-dir <offline-state-dir> (stdout only)')
    console.log(JSON.stringify(exportTickets({ stateDir: args[1] }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
