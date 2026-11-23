// One-shot, idempotent worker -> executor data migration.
//
// It rewrites state.json and events.jsonl from the legacy key names to the new
// executor names. The transformation is pure; files are only written when at
// least one legacy key exists, so a second run is a byte-for-byte no-op.
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureDir, writeAtomic } from '../../shared/fs.mjs'
import { hasLegacyKeys, renameLegacyKeys } from '../worker-executor-keys.mjs'

export const MIGRATION_VERSION = 1

const pad = value => String(value).padStart(2, '0')

export function backupStamp(at = Date.now()) {
  const date = new Date(at)
  return String(date.getFullYear())
    + pad(date.getMonth() + 1)
    + pad(date.getDate())
    + '-'
    + pad(date.getHours())
    + pad(date.getMinutes())
    + pad(date.getSeconds())
}

export function defaultBackupRoot(at = Date.now()) {
  return join(homedir(), '.dsh', 'state', 'ria', 'backups', backupStamp(at))
}

export function migrateStateText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('state.json is not valid JSON: ' + String(error && error.message ? error.message : error))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('state.json must contain a JSON object')
  }
  if (!hasLegacyKeys(parsed)) return { changed: false, text, value: parsed }
  const value = renameLegacyKeys(parsed)
  return { changed: true, text: JSON.stringify(value, null, 2) + '\n', value }
}

export function migrateEventsText(text) {
  const lines = String(text).split('\n')
  let changedLines = 0
  const output = lines.map(line => {
    if (!line.trim()) return line
    let row
    try {
      row = JSON.parse(line)
    } catch {
      // Unparseable history is preserved exactly, in place.
      return line
    }
    if (!row || typeof row !== 'object' || Array.isArray(row) || !hasLegacyKeys(row)) return line
    changedLines += 1
    return JSON.stringify(renameLegacyKeys(row))
  })
  return { changed: changedLines > 0, changedLines, text: output.join('\n') }
}

function stableRewrite(file, originalText, nextText) {
  writeAtomic(file, nextText, {
    beforeRename: () => {
      // A running Ria may append to events.jsonl. Never overwrite bytes that
      // changed since the transformation; let the caller retry.
      const current = readFileSync(file, 'utf8')
      if (current !== originalText) throw new Error('file changed during migration; retry when the writer is idle: ' + file)
    },
  })
}

function migrateFile(file, transform, { dryRun, backupDir }) {
  if (!existsSync(file)) return { file, present: false, changed: false }
  const original = readFileSync(file, 'utf8')
  const result = transform(original)
  if (!result.changed) return { file, present: true, changed: false, ...(result.changedLines !== undefined ? { changedLines: result.changedLines } : {}) }
  let backup = null
  if (!dryRun) {
    ensureDir(backupDir)
    backup = join(backupDir, file.split(/[\\/]/).pop())
    copyFileSync(file, backup)
    stableRewrite(file, original, result.text)
  }
  return {
    file,
    present: true,
    changed: true,
    backup,
    ...(result.changedLines !== undefined ? { changedLines: result.changedLines } : {}),
  }
}

/**
 * Migrate one state directory. Returns a small summary; dryRun never writes and
 * never creates the backup directory.
 */
export function migrateWorkerToExecutor({ stateDir, dryRun = false, backupRoot = null, now = Date.now() } = {}) {
  if (!stateDir) throw new Error('stateDir is required')
  const stateFile = join(stateDir, 'state.json')
  const eventsFile = join(stateDir, 'events.jsonl')
  const backupDir = backupRoot || defaultBackupRoot(now)
  const state = migrateFile(stateFile, migrateStateText, { dryRun, backupDir })
  const events = migrateFile(eventsFile, migrateEventsText, { dryRun, backupDir })
  const changed = Boolean(state.changed || events.changed)
  return {
    ok: true,
    dryRun,
    migration: 'worker-to-executor',
    version: MIGRATION_VERSION,
    changed,
    backupDir: changed && !dryRun ? backupDir : null,
    state,
    events,
  }
}
