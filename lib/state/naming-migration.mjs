// TEMPORARY one-shot migration for the state -> state naming change.
// Runs at RiaService startup (not in StateStore): backs up legacy files,
// renames state.json to state.json, renames state metadata keys in JSON/SQLite and
// renames legacy state columns. Idempotent; keep one release, then delete.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appendOperationLog } from './operation-log.mjs'

const renameKeys = (value) => {
  if (Array.isArray(value)) return value.map(renameKeys)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const nextKey = key === 'v2' ? 'state' : key === 'pendingV2' ? 'pendingState' : key
    out[nextKey] = renameKeys(item)
  }
  return out
}

const countV2Keys = (value) => {
  if (Array.isArray(value)) return value.reduce((n, item) => n + countV2Keys(item), 0)
  if (!value || typeof value !== 'object') return 0
  return Object.entries(value).reduce((n, [key, item]) => n + (key === 'v2' || key === 'pendingV2' ? 1 : 0) + countV2Keys(item), 0)
}

const rewriteJson = (file) => {
  if (!existsSync(file)) return { changed: false, keys: 0 }
  const before = readFileSync(file, 'utf8')
  let parsed
  try { parsed = JSON.parse(before) } catch { return { changed: false, keys: 0 } }
  const after = JSON.stringify(renameKeys(parsed), null, 2) + '\n'
  if (after === before) return { changed: false, keys: 0 }
  writeFileSync(file, after)
  return { changed: true, keys: countV2Keys(parsed) }
}

/**
 * Migrate legacy state naming. Leaves a complete copy of every touched file under
 * stateDir/naming-migration-<ts>/, plus state.json.bak-<ts>. Returns
 * { backupDir, changed, files }; backupDir is null when nothing needed doing.
 */
export function migrateLegacyState({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backupDir = join(stateDir, 'naming-migration-' + stamp)
  const oldJson = join(stateDir, 'v2.json')
  const newJson = join(stateDir, 'state.json')
  const log = (record) => { try { appendOperationLog(stateDir, record) } catch {} }
  log({ event: 'naming_migration.start', stateDir, dbPath })
  const hasOld = existsSync(oldJson)
  const hasNew = existsSync(newJson)
  const dbExists = existsSync(dbPath)
  let needs = hasOld
  for (const name of ['state.json', 'ria.json']) {
    try { if (readFileSync(join(stateDir, name), 'utf8').includes('"v2"')) needs = true } catch {}
  }
  if (dbExists) {
    try {
      const probe = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        const hasColumn = tables.some(table => probe.prepare('PRAGMA table_info("' + table.name.replaceAll('"', '""') + '")').all().some(col => /state/i.test(col.name)))
        const hasEnvelope = probe.prepare("SELECT COUNT(*) n FROM tickets WHERE json_type(meta,'$.v2')='object'").get().n > 0
        const hasMeta = probe.prepare("SELECT COUNT(*) n FROM schema_meta WHERE value LIKE '%state%'").get().n > 0
        if (hasColumn || hasEnvelope || hasMeta) needs = true
      } finally { probe.close() }
    } catch { needs = true }
  }
  if (!needs) {
    log({ event: 'naming_migration.noop', reason: 'already migrated' })
    return { backupDir: null, changed: false, files: [] }
  }

  mkdirSync(backupDir, { recursive: true })
  const files = []
  for (const name of ['v2.json', 'state.json', 'ria.json', 'ria.sqlite', 'ria.sqlite-wal', 'ria.sqlite-shm', 'tickets.log.jsonl']) {
    const source = join(stateDir, name)
    if (!existsSync(source)) continue
    copyFileSync(source, join(backupDir, name))
    files.push(name)
  }
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
    tool: 'lib/state/naming-migration.mjs', createdAt: now, stateDir, dbPath, files: [...files],
  }, null, 2) + '\n')
  let changed = false
  let filesCount = 0
  let keys = 0
  let columns = 0
  if (hasOld && !hasNew) {
    copyFileSync(oldJson, oldJson + '.bak-' + stamp)
    renameSync(oldJson, newJson)
    changed = true
    filesCount += 1
  }
  for (const name of ['state.json', 'ria.json']) {
    const rewritten = rewriteJson(join(stateDir, name))
    if (rewritten.changed) { changed = true; filesCount += 1; keys += rewritten.keys }
  }
  if (dbExists) {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('BEGIN IMMEDIATE')
      const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map(row => row.name)
      if (ticketCols.includes('meta')) {
        const rows = db.prepare("SELECT id, meta FROM tickets WHERE json_type(meta,'$.v2')='object'").all()
        for (const row of rows) {
          const envelope = JSON.parse(row.meta)
          if (Object.hasOwn(envelope, 'v2')) {
            envelope.state = envelope.v2
            delete envelope.v2
            db.prepare('UPDATE tickets SET meta=? WHERE id=?').run(JSON.stringify(envelope), row.id)
            changed = true
            keys += 1
          }
        }
      }
      for (const row of db.prepare('SELECT key, value FROM schema_meta').all()) {
        try {
          const next = JSON.stringify(renameKeys(JSON.parse(row.value)))
          if (next !== row.value) { db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(next, row.key); changed = true; keys += 1 }
        } catch {}
      }
      for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        const name = table.name
        const cols = db.prepare('PRAGMA table_info("' + name.replaceAll('"', '""') + '")').all()
        for (const col of cols) {
          if (!/v2/i.test(col.name)) continue
          const next = col.name.replace(/v2/gi, 'state')
          db.exec('ALTER TABLE "' + name.replaceAll('"', '""') + '" RENAME COLUMN "' + col.name.replaceAll('"', '""') + '" TO "' + next.replaceAll('"', '""') + '"')
          changed = true
          columns += 1
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      if (files.includes('state.json') && !existsSync(oldJson)) copyFileSync(join(backupDir, 'state.json'), oldJson)
      for (const name of ['state.json', 'ria.json']) if (files.includes(name)) copyFileSync(join(backupDir, name), join(stateDir, name))
      throw error
    } finally { db.close() }
  }
  if (!changed) {
    // Detection can be conservative (e.g. a stale LIKE probe); never leave an
    // empty backup behind when the second run did not touch anything.
    log({ event: 'naming_migration.noop', reason: 'already migrated' })
    rmSync(backupDir, { recursive: true, force: true })
    return { backupDir: null, changed: false, files: [] }
  }
  log({ event: 'naming_migration.finish', backupDir: changed ? backupDir : null, changed, counts: { files: filesCount, keys, columns } })
  return { backupDir, changed, files }
}

export function restoreLegacyNaming({ stateDir, backupDir }) {
  if (!backupDir || !existsSync(backupDir)) return false
  for (const name of ['v2.json', 'state.json', 'ria.json', 'ria.sqlite', 'ria.sqlite-wal', 'ria.sqlite-shm', 'tickets.log.jsonl']) {
    const source = join(backupDir, name)
    if (existsSync(source)) copyFileSync(source, join(stateDir, name))
  }
  return true
}