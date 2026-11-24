import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMirrorSnapshot, writeMirrorSnapshot } from '../lib/state/sqlite/mirror.mjs'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'

// legacy: offline rollback/export path; reads ria.json/state.json only to
// rebuild a JSON-mode snapshot. Live runtime does not use this reader.
export function exportTickets({ stateDir, dbPath = join(stateDir, 'ria.sqlite') }) {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    const read = (name, fallback) => existsSync(join(stateDir, name)) ? JSON.parse(readFileSync(join(stateDir, name), 'utf8')) : fallback
    const ria = read('ria.json', { schemaVersion: 5, version: 5 })
    const state = read('state.json', {})
    // Offline only: disk is the source for non-ticket domains, never tickets
    // or metadata. One read transaction pins DB rows/history/meta/archives.
    db.exec('BEGIN')
    try {
      const mirror = JSON.parse(adapter.getSchemaMeta('ticket_mirror') || '{}')
      // Failed/unfinished online export left a committed recovery payload. It
      // is newer than disk; retain those non-ticket fields during offline export.
      const dirty = mirror.dirty === true || (mirror.exportedGeneration ?? -1) < (mirror.generation ?? 0)
      return buildMirrorSnapshot({ records: adapter.records(), counts: adapter.counts(),
        ria: { ...ria, ...(dirty ? mirror.pendingRia : null) },
        state: { ...state, ...(dirty ? mirror.pendingState : null) }, generation: mirror.generation || 0 })
    } finally { db.exec('ROLLBACK') }
  } finally { db.close() }
}

/**
 * One-command rollback: rebuild ria.json / state.json from the DB and set
 * storage=json. The retired tickets.log.jsonl is never recreated. The DB file
 * is left in place for a later retry.
 */
export function writeExport({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), now = Date.now() }) {
  const exported = exportTickets({ stateDir, dbPath })
  writeMirrorSnapshot({ stateDir, snapshot: exported, storage: 'json', writeRia: true })
  return {
    ok: true,
    mode: 'rollback',
    storage: 'json',
    rolledBackAt: now,
    counts: exported.counts,
    files: ['ria.json', 'state.json'],
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
