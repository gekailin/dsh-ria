import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './db.mjs'
import { SqliteTicketAdapter } from './adapter.mjs'

const sha256 = raw => createHash('sha256').update(raw).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => Object.assign(new Error(message), { code: 'invalid_migration_source' })

function readJson(stateDir, name, fallback) {
  const path = join(stateDir, name)
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Offline read-only source. SQLite is authoritative when ria.sqlite exists;
 * the JSON fallback is only for seeding a fresh test/migration DB and no
 * longer reads the retired tickets.log.jsonl archive.
 */
export function readStateSource(stateDir, { preferSqlite = true } = {}) {
  const dbPath = join(stateDir, 'ria.sqlite')
  if (preferSqlite && existsSync(dbPath)) return readSqliteSource(stateDir, dbPath)

  const names = ['ria.json', 'state.json', 'outbox.json'].filter(name => existsSync(join(stateDir, name)))
  if (!names.includes('ria.json')) throw fail('ria.json is required; run this check against an offline/maintenance snapshot')
  const files = names.map(name => {
    const raw = readFileSync(join(stateDir, name))
    return { name, bytes: raw.length, sha256: sha256(raw), raw }
  })
  const parseFile = (name, fallback) => {
    const file = files.find(item => item.name === name)
    if (!file) return fallback
    return JSON.parse(file.raw.toString('utf8'))
  }
  const ria = parseFile('ria.json', {})
  const state = parseFile('state.json', {})
  if (!Array.isArray(ria.tickets)) throw fail('ria.json.tickets must be an array (upgrade old JSON schema first)')
  const records = []
  const hotIds = new Set()
  for (const ticket of ria.tickets) {
    if (!ticket || typeof ticket.ticketId !== 'string' || !ticket.ticketId || hotIds.has(ticket.ticketId)) throw fail('Invalid/duplicate hot ticket id')
    hotIds.add(ticket.ticketId)
    records.push({ ticket: clone(ticket), archivedAt: null, meta: null, archiveRecords: [] })
  }
  const counts = {
    tickets: records.length,
    history: records.reduce((sum, record) => sum + (Array.isArray(record.ticket.history) ? record.ticket.history.length : 0), 0),
    hot: hotIds.size,
    archived: 0,
    meta: null,
  }
  const sourceSha256 = sha256(files.map(({ name, sha256 }) => name + '\u0000' + sha256).join('\n'))
  return { records, ria, state, counts, files, sourceSha256, importId: 'import_' + sourceSha256 }
}

function readSqliteSource(stateDir, dbPath) {
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    const records = adapter.records()
    const counts = adapter.counts()
    const files = ['ria.json', 'state.json', 'outbox.json'].filter(name => existsSync(join(stateDir, name))).map(name => {
      const raw = readFileSync(join(stateDir, name))
      return { name, bytes: raw.length, sha256: sha256(raw), raw }
    })
    const dbRaw = readFileSync(dbPath)
    files.push({ name: 'ria.sqlite', bytes: dbRaw.length, sha256: sha256(dbRaw) })
    const ria = readJson(stateDir, 'ria.json', {
      schemaVersion: 5,
      tickets: records.filter(record => record.archivedAt === null).map(record => clone(record.ticket)),
    })
    const state = readJson(stateDir, 'state.json', {})
    const computedHash = sha256(files.map(({ name, sha256 }) => name + '\u0000' + sha256).join('\n'))
    const sourceSha256 = adapter.getSchemaMeta('source_sha256') || computedHash
    const importId = adapter.getSchemaMeta('import_id') || ('import_' + computedHash)
    return { records, ria, state, counts, files, sourceSha256, importId }
  } finally { db.close() }
}

export { sha256 }
