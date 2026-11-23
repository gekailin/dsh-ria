#!/usr/bin/env node
// Migrate ~/.dsh/state/ria (or --state-dir) from worker* keys to executor*.
// Safe defaults: --dry-run only reports; real runs back up first and are
// idempotent, so a second run is a byte-for-byte no-op.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { migrateWorkerToExecutor, defaultBackupRoot } from '../lib/state/migrations/worker-to-executor.mjs'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const stateDir = argValue('--state-dir', process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'state', 'ria')
  : join(homedir(), '.dsh', 'state', 'ria'))
const dryRun = process.argv.includes('--dry-run')
const backupRoot = argValue('--backup-root', null)

try {
  const result = migrateWorkerToExecutor({ stateDir, dryRun, backupRoot: backupRoot || defaultBackupRoot() })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write('migration failed: ' + String(error && error.message ? error.message : error) + '\n')
  process.exit(1)
}
