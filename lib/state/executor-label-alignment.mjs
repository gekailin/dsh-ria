// One-off executorLabel alignment for persisted state.
//
// The live Session title is the source of truth. This module writes only
// state.json; events.jsonl is never opened, so historical worker* payload keys
// and line order stay untouched. A second run is a no-op (and creates no new
// backup).
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../shared/fs.mjs'

const text = value => typeof value === 'string' ? value.trim() : ''
const stamp = at => new Date(at).toISOString().replace(/[:.]/g, '-')

export function defaultStateDir() {
  return process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'state', 'ria')
    : join(homedir(), '.dsh', 'state', 'ria')
}

export function defaultProjectionCacheDir() {
  return process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions')
    : join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
}

/** Current Session title from DSH's projection cache (read-only). */
export function projectionCacheTitle(cacheDir, sessionId) {
  const file = join(cacheDir, String(sessionId) + '.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const row = parsed && parsed.record && parsed.record.rows ? parsed.record.rows.title : null
    const value = row && typeof row === 'object' && Object.hasOwn(row, 'val') ? row.val : row
    return text(value)
  } catch {
    return ''
  }
}

/**
 * Align every executorLabel with resolveTitle(sessionId). Only non-empty titles
 * change anything; missing/unavailable titles keep the existing label.
 */
export async function alignExecutorLabels({
  stateDir = defaultStateDir(),
  resolveTitle,
  dryRun = false,
  backup = true,
  now = Date.now(),
} = {}) {
  if (!stateDir) throw new Error('stateDir is required')
  if (typeof resolveTitle !== 'function') throw new Error('resolveTitle is required')
  const statePath = join(stateDir, 'state.json')
  if (!existsSync(statePath)) throw new Error('state.json is missing: ' + statePath)
  const beforeText = readFileSync(statePath, 'utf8')
  let data
  try {
    data = JSON.parse(beforeText)
  } catch (error) {
    throw new Error('state.json is not valid JSON: ' + String(error && error.message ? error.message : error))
  }
  if (!data || typeof data !== 'object' || !data.executors || typeof data.executors !== 'object') {
    throw new Error('state.json has no executors object: ' + statePath)
  }
  const changes = []
  for (const [sessionId, executor] of Object.entries(data.executors)) {
    if (!executor || typeof executor !== 'object') continue
    let title = ''
    try {
      title = text(await resolveTitle(sessionId, executor))
    } catch {
      title = ''
    }
    if (!title || executor.executorLabel === title) continue
    changes.push({ sessionId, before: executor.executorLabel === undefined ? null : executor.executorLabel, after: title })
    executor.executorLabel = title
  }
  const result = {
    ok: true,
    changed: changes.length > 0,
    dryRun: Boolean(dryRun),
    statePath,
    checked: Object.keys(data.executors).length,
    updated: changes.length,
    changes,
    backupFile: null,
  }
  if (!changes.length || dryRun) return result
  if (backup) {
    const backupFile = statePath + '.bak.' + stamp(now)
    copyFileSync(statePath, backupFile)
    result.backupFile = backupFile
  }
  writeAtomic(statePath, JSON.stringify(data, null, 2) + '\n')
  return result
}

/** Convenience wrapper: titles come from DSH's projection cache. */
export async function alignExecutorLabelsFromProjectionCache({
  stateDir = defaultStateDir(),
  cacheDir = defaultProjectionCacheDir(),
  dryRun = false,
  backup = true,
  now = Date.now(),
} = {}) {
  return await alignExecutorLabels({
    stateDir,
    dryRun,
    backup,
    now,
    resolveTitle: sessionId => projectionCacheTitle(cacheDir, sessionId),
  })
}
