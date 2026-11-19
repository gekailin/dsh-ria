import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.mjs'

const require = createRequire(import.meta.url)
const error = (code, message) => Object.assign(new Error(message), { code })

// Lazy loading keeps storage=json working on hosts without node:sqlite.
export function openDatabase(path, { create = false, readOnly = false, checkpoint = false } = {}) {
  if (path !== ':memory:' && !existsSync(path) && !create) {
    throw error('sqlite_missing', 'SQLite DB is missing: ' + path + '; migrate offline or select storage=json explicitly')
  }
  let DatabaseSync
  try { ({ DatabaseSync } = require('node:sqlite')) } catch {
    throw error('sqlite_unavailable', 'storage=sqlite requires a Node runtime with node:sqlite (Node >=24 recommended)')
  }
  if (typeof DatabaseSync !== 'function') throw error('sqlite_unavailable', 'node:sqlite DatabaseSync is unavailable')
  if (create && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    if (!readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000;')
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").get()
    if (!hasMeta) {
      if (!create || readOnly) throw error('sqlite_schema_missing', 'SQLite schema is missing; run the offline migration first')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(SCHEMA_SQL)
        db.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?)').run('schema_version', String(SCHEMA_VERSION), Date.now())
        db.exec('PRAGMA user_version=' + SCHEMA_VERSION + '; COMMIT')
      } catch (cause) { db.exec('ROLLBACK'); throw cause }
    }
    const version = Number(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value)
    if (version !== SCHEMA_VERSION) throw error('sqlite_schema_version', 'Unsupported SQLite schema version ' + version + ' (expected ' + SCHEMA_VERSION + '); do not downgrade/import automatically')
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw error('sqlite_corrupt', 'SQLite integrity check failed: ' + JSON.stringify(integrity))
    if (checkpoint && !readOnly) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    if (readOnly) db.exec('PRAGMA query_only=ON')
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

export function transaction(db, task) {
  if (task?.constructor?.name === 'AsyncFunction') throw error('async_transaction', 'Transactions require synchronous functions; await model/session calls outside')
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = task()
    if (result && typeof result.then === 'function') throw error('async_transaction', 'A transaction must not return a Promise')
    db.exec('COMMIT')
    return result
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

export function closeDatabase(db) { if (db) db.close() }
