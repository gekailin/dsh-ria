#!/usr/bin/env node
// One-off, idempotent executorLabel alignment.
//
// Usage:
//   node scripts/align-executor-labels.mjs [--state-dir <dir>] [--cache-dir <dir>] [--dry-run]
//
// Only state.json is written. events.jsonl is never opened.
import { alignExecutorLabelsFromProjectionCache, defaultProjectionCacheDir, defaultStateDir } from '../lib/state/executor-label-alignment.mjs'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

try {
  const result = await alignExecutorLabelsFromProjectionCache({
    stateDir: argValue('--state-dir', defaultStateDir()),
    cacheDir: argValue('--cache-dir', defaultProjectionCacheDir()),
    dryRun: process.argv.includes('--dry-run'),
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write('executorLabel alignment failed: ' + String(error && error.message ? error.message : error) + '\n')
  process.exit(1)
}
