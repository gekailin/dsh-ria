import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../lib/state/atomic-file.mjs'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'

const TICKET_LOG = 'tickets.log.jsonl'

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

/**
 * One-command rollback: rebuild ria.json / v2.json / tickets.log.jsonl from the
 * DB and set storage=json. The DB file is left in place for a later retry.
 */
export function writeExport({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), now = Date.now() }) {
  const exported = exportTickets({ stateDir, dbPath })
  const ria = { ...exported.ria, storage: 'json' }
  const v2 = { ...exported.v2 }
  writeAtomic(join(stateDir, 'ria.json'), JSON.stringify(ria, null, 2) + '\n')
  writeAtomic(join(stateDir, 'v2.json'), JSON.stringify(v2, null, 2) + '\n')
  const archives = exported.archives
    .filter(record => record && record.ticket && typeof record.ticket.ticketId === 'string')
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
  if (archives.length) writeAtomic(join(stateDir, TICKET_LOG), archives.map(record => JSON.stringify(record)).join('\n') + '\n')
  return {
    ok: true,
    mode: 'rollback',
    storage: 'json',
    rolledBackAt: now,
    counts: exported.counts,
    files: ['ria.json', 'v2.json', ...(archives.length ? [TICKET_LOG] : [])],
    next: 'Restart the service (or unset DSH_RIA_STORAGE) so storage=json takes effect; the DB file is kept for retry.',
  }
}

export function cliArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state-dir') result.stateDir = argv[++i]
    else if (arg === '--db') result.dbPath = argv[++i]
    else if (arg === '--apply') result.apply = true
    else throw new Error('Unknown argument: ' + arg)
  }
  if (!result.stateDir) throw new Error('Usage: node scripts/sqlite-export.mjs --state-dir <state-dir> [--db <path>] [--apply]')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = cliArgs(process.argv.slice(2))
    const result = args.apply ? writeExport(args) : exportTickets(args)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
