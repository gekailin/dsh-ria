// Shared filesystem helpers for new code. writeAtomic is the canonical
// implementation; the small JSON/dir helpers are thin, side-effect-explicit
// wrappers so callers do not grow another copy.
import * as fs from 'node:fs'
import { dirname } from 'node:path'
export { writeAtomic } from '../state/atomic-file.mjs'
import { writeAtomic } from '../state/atomic-file.mjs'

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  return dir
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
