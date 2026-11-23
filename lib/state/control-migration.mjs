import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic-file.mjs'

export const RIA_CONTROL_KEYS = ['settings', 'grants', 'recentExecutors', 'ticketFeedback',
  'riaSessionId', 'riaPreset', 'version', 'createdAt', 'lastHumanMessageAt', 'storage']

/** Move the remaining control-plane fields out of ria.json into state.json.
 * ria.json stays on disk as a read-only rollback copy; the migration is
 * idempotent and only fills keys that are missing from state.json. */
export function migrateRiaControl({ stateDir, now = Date.now() } = {}) {
  const riaPath = join(stateDir, 'ria.json')
  const statePath = join(stateDir, 'state.json')
  if (!existsSync(riaPath)) return { ok: true, mode: 'noop', moved: [], backup: null }
  let ria
  try { ria = JSON.parse(readFileSync(riaPath, 'utf8')) } catch { return { ok: true, mode: 'noop', moved: [], backup: null } }
  let state = {}
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { state = {} }
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {}
  const moved = RIA_CONTROL_KEYS.filter(key => !Object.hasOwn(state, key) && Object.hasOwn(ria, key))
  if (!moved.length) return { ok: true, mode: 'noop', moved: [], backup: null }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backup = riaPath + '.bak-' + stamp
  writeAtomic(backup, readFileSync(riaPath))
  for (const key of moved) state[key] = ria[key]
  writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n')
  return { ok: true, mode: 'migrated', moved, backup }
}
