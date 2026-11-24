// Shared filesystem helpers. writeAtomic is the canonical implementation; the
// JSON/dir helpers are thin, side-effect-explicit wrappers so callers never grow
// another copy of the fsync+rename dance.
import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export const STATE_TMP_MAX_AGE_MS = 10 * 60 * 1000
export const STATE_TMP_PREFIX = 'state.json.tmp-'
const LEGACY_STATE_TMP = /^state\.json\..+\.tmp$/

const activeTargets = new Set()

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  return dir
}

function fsyncDirectory(io, file) {
  const dir = dirname(file)
  let fd
  try {
    fd = io.openSync(dir, 'r')
    io.fsyncSync(fd)
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch { /* preserve original error */ } }
  }
}

/** Publish a complete file in its own directory. Short writes are retried;
 * before rename the old target is untouched, and failed staging is removed.
 * fsync covers the file bytes; atomic rename is not a multi-file transaction.
 * The parent directory is fsynced after rename so the rename itself is durable.
 * The io seam is for deterministic fault injection, never a sandbox bypass.
 */
export function writeAtomic(file, value, { mode = 0o600, io = fs, beforeRename = null } = {}) {
  const target = String(file)
  if (activeTargets.has(target)) {
    throw Object.assign(new Error('Atomic write already in progress for ' + target), { code: 'atomic_write_busy' })
  }
  activeTargets.add(target)
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  let temp
  let fd
  let published = false
  try {
    io.mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    // Unique same-directory name: same filesystem for rename; pid + UUID means
    // two writes can never share a staging file.
    temp = target + '.tmp-' + process.pid + '-' + randomUUID()
    fd = io.openSync(temp, 'wx', mode)
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!Number.isSafeInteger(written) || written <= 0) throw new Error('Atomic file write made no progress: ' + target)
      offset += written
    }
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    if (beforeRename) beforeRename()
    io.renameSync(temp, target)
    published = true
    // Persist the directory entry too. A failed dir fsync leaves the new target
    // in place (the data was already fsynced); the caller still sees the error.
    fsyncDirectory(io, target)
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch { /* preserve original error */ } }
    if (!published && temp) { try { io.unlinkSync(temp) } catch { /* staging may never have opened */ } }
    activeTargets.delete(target)
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  ensureDir(dirname(file))
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n', options)
}

export function readJsonSafe(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/**
 * Remove stale state.json staging files left by a crash. Only the state
 * directory is scanned; missing/unreadable directories and individual unlink
 * failures never throw. The caller records the returned names as one event.
 */
export function cleanupStaleStateTemps(stateDir, { now = Date.now, maxAgeMs = STATE_TMP_MAX_AGE_MS, io = fs, log = null } = {}) {
  const removed = []
  const errors = []
  let entries
  try { entries = io.readdirSync(stateDir, { withFileTypes: true }) } catch { return { removed, errors } }
  for (const entry of entries) {
    const name = String(entry.name || '')
    if (!entry.isFile()) continue
    if (!name.startsWith(STATE_TMP_PREFIX) && !LEGACY_STATE_TMP.test(name)) continue
    const path = join(String(stateDir), name)
    try {
      const stat = io.statSync(path)
      const ageMs = Math.max(0, Number(now()) - Number(stat.mtimeMs))
      if (ageMs <= maxAgeMs) continue
      io.unlinkSync(path)
      removed.push({ name, ageMs })
    } catch (error) {
      errors.push({ name, error: String(error && error.message ? error.message : error) })
      try { if (typeof log === 'function') log('warn', 'could not remove stale sibling ' + path + ': ' + String(error && error.message ? error.message : error)) } catch { /* warn only */ }
    }
  }
  return { removed, errors }
}
