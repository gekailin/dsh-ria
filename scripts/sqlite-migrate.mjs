import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { writeAtomic } from '../lib/state/atomic-file.mjs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { readMigrationSource } from '../lib/state/sqlite/source.mjs'
import { verifyDatabase } from '../lib/state/sqlite/verify.mjs'

const error = (code, message) => Object.assign(new Error(message), { code })

const stamp = (now = Date.now()) => new Date(now).toISOString().replace(/[:.]/g, '-')

/** Copy the JSON sources into state/backup/<ts>/ and write the manifest that makes
 * a rollback auditable. Nothing is published unless every check passes. */
export function backupState({ stateDir, source, backupDir, dbPath, now = Date.now() }) {
  const root = backupDir || join(stateDir, 'backup')
  let dir = join(root, stamp(now))
  for (let index = 2; existsSync(dir); index += 1) dir = join(root, stamp(now) + '-' + index)
  mkdirSync(dir, { recursive: true })
  const files = []
  for (const file of source.files) {
    const target = join(dir, file.name)
    mkdirSync(dirname(target), { recursive: true })
    writeAtomic(target, file.raw)
    files.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 })
  }
  if (dbPath && existsSync(dbPath)) {
    // A replaced DB is backed up next to the JSON so a rollback can restore it.
    const name = 'ria.sqlite'
    writeAtomic(join(dir, name), readFileSync(dbPath))
    files.push({ name, bytes: readFileSync(join(dir, name)).length, sha256: hashFile(join(dir, name)) })
  }
  const manifest = {
    tool: 'scripts/sqlite-migrate.mjs',
    schemaVersion: 1,
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    stateDir,
    dbPath: dbPath || null,
    importId: source.importId,
    sourceSha256: source.sourceSha256,
    counts: source.counts,
    files,
  }
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifest }
}

function hashFile(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

function removeDatabase(path) {
  for (const suffix of ['', '-wal', '-shm', '.tmp', '.tmp-wal', '.tmp-shm']) {
    try { rmSync(path + suffix, { force: true }) } catch { /* best effort cleanup */ }
  }
}

function importSource(db, source) {
  const adapter = new SqliteTicketAdapter(db)
  transaction(db, () => {
    for (const record of source.records) adapter.save(record.ticket, record)
    adapter.setSchemaMeta('import_id', source.importId)
    adapter.setSchemaMeta('source_sha256', source.sourceSha256)
    adapter.setSchemaMeta('imported_at', String(Date.now()))
  })
  return adapter
}

function publish(tmpPath, dbPath) {
  for (const suffix of ['-wal', '-shm']) rmSync(tmpPath + suffix, { force: true })
  renameSync(tmpPath, dbPath)
}

function describe(verification) {
  return {
    ok: verification.ok,
    counts: verification.counts.actual,
    countsMatch: verification.counts.ok,
    integrity: verification.integrity.integrity,
    foreignKeyViolations: verification.integrity.foreignKeys.length,
    orphanHistory: verification.integrity.orphanHistory,
    sampled: verification.sample.sampled,
    sampleMismatches: verification.sample.results.filter(result => !result.ok),
    importId: verification.provenance.importId,
    sourceSha256: verification.provenance.sourceSha256,
  }
}

/**
 * Offline JSON -> SQLite ticket migration.
 *
 * - same source re-run is a verified no-op (import_id/source_sha256 idempotency)
 * - a different source on an existing DB needs --replace (maintenance window)
 * - the DB is built in <dbPath>.tmp and only renamed into place after counts,
 *   stratified 20-ticket deep comparison, integrity_check and foreign_key_check pass
 * - JSON is never modified; on any failure the tmp DB is removed and the JSON stays
 */
export function migrateTickets({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), backupDir, sampleSize = 20, replace = false, verifyOnly = false, now = Date.now() } = {}) {
  if (!stateDir) throw error('invalid_arguments', 'stateDir is required')
  const source = readMigrationSource(stateDir)
  if (verifyOnly) {
    if (!existsSync(dbPath)) throw error('sqlite_missing', 'SQLite DB is missing: ' + dbPath)
    const db = openDatabase(dbPath, { readOnly: true })
    try {
      const verification = verifyDatabase(db, new SqliteTicketAdapter(db), source, { sampleSize, requireSourceHash: false })
      return { ok: verification.ok, mode: 'verify-only', dbPath, ...describe(verification) }
    } finally { db.close() }
  }
  if (existsSync(dbPath)) {
    const db = openDatabase(dbPath)
    try {
      const adapter = new SqliteTicketAdapter(db)
      const previous = adapter.getSchemaMeta('source_sha256')
      if (previous === source.sourceSha256 && !replace) {
        const verification = verifyDatabase(db, adapter, source, { sampleSize })
        return { ok: verification.ok, mode: 'idempotent-reuse', dbPath, replaced: false, ...describe(verification) }
      }
      if (!replace) {
        throw error('import_conflict', 'SQLite DB already holds a different source (' + String(previous) + '); re-run in a maintenance window with --replace after reviewing state/backup')
      }
    } finally { db.close() }
  }
  const backup = backupState({ stateDir, source, backupDir, dbPath, now })
  const tmpPath = dbPath + '.tmp'
  removeDatabase(dbPath + '.tmp')
  let db
  try {
    db = openDatabase(tmpPath, { create: true })
    const adapter = importSource(db, source)
    const verification = verifyDatabase(db, adapter, source, { sampleSize })
    if (!verification.ok) {
      throw error('migration_verification_failed', 'migration verification failed: ' + JSON.stringify(describe(verification)))
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    publish(tmpPath, dbPath)
    return { ok: true, mode: replace ? 'replaced' : 'created', dbPath, backupDir: backup.dir, replaced: Boolean(replace), ...describe(verification) }
  } catch (cause) {
    if (db) { try { db.close() } catch { /* already closed */ } }
    removeDatabase(tmpPath)
    cause.cleaned = true
    cause.backupDir = backup.dir
    throw cause
  }
}


export function repairTicketMeta({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), dryRun = false } = {}) {
  if (!stateDir) throw error('invalid_arguments', 'stateDir is required')
  if (!existsSync(dbPath)) throw error('sqlite_missing', 'SQLite DB is missing: ' + dbPath)
  const source = readMigrationSource(stateDir)
  const metaById = new Map(source.records.filter(record => record.meta != null)
    .map(record => [record.ticket.ticketId, record.meta]))
  const db = openDatabase(dbPath)
  try {
    const adapter = new SqliteTicketAdapter(db)
    const missing = adapter.records({ includeArchived: true })
      .filter(record => record.meta == null && metaById.has(record.ticket.ticketId))
    const ticketIds = missing.map(record => record.ticket.ticketId)
    if (!dryRun && missing.length) {
      transaction(db, () => {
        for (const record of missing) adapter.save(record.ticket, { ...record, meta: metaById.get(record.ticket.ticketId) })
      })
    }
    return { ok: true, mode: 'repair-meta', dryRun, repaired: missing.length, ticketIds }
  } finally { db.close() }
}

function verificationFailed(result) {
  return result.mode === 'verify-only' && (result.ok === false || result.countsMatch === false
    || (Array.isArray(result.sampleMismatches) && result.sampleMismatches.length > 0)
    || !Array.isArray(result.integrity) || result.integrity.some(value => value !== 'ok')
    || result.foreignKeyViolations > 0 || result.orphanHistory > 0)
}

export function cliArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state-dir') result.stateDir = argv[++i]
    else if (arg === '--db') result.dbPath = argv[++i]
    else if (arg === '--backup-dir') result.backupDir = argv[++i]
    else if (arg === '--sample') result.sampleSize = Number(argv[++i])
    else if (arg === '--replace') result.replace = true
    else if (arg === '--verify-only') result.verifyOnly = true
    else if (arg === '--repair-meta') result.repairMeta = true
    else throw new Error('Unknown argument: ' + arg)
  }
  if (!result.stateDir) throw new Error('Usage: node scripts/sqlite-migrate.mjs --state-dir <offline-state-dir> [--db <path>] [--backup-dir <path>] [--sample 20] [--replace] [--verify-only] [--repair-meta]')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = cliArgs(process.argv.slice(2))
    const result = args.repairMeta ? repairTicketMeta(args) : migrateTickets(args)
    console.log(JSON.stringify(result, null, 2))
    if (verificationFailed(result)) process.exitCode = 1
  } catch (cause) { console.error(JSON.stringify({ ok: false, code: cause.code || 'error', message: cause.message })); process.exitCode = 1 }
}
