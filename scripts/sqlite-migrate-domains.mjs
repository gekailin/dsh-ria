#!/usr/bin/env node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrateDomains } from '../lib/state/sqlite/domain-migration.mjs'

export function cliArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--state-dir') result.stateDir = argv[++i]
    else if (arg === '--db') result.dbPath = argv[++i]
    else if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/sqlite-migrate-domains.mjs --state-dir <stateDir> [--db <path>] [--dry-run]\n')
      process.exit(0)
    } else throw new Error('Unknown argument: ' + arg)
  }
  if (!result.stateDir) throw new Error('Usage: node scripts/sqlite-migrate-domains.mjs --state-dir <stateDir> [--db <path>] [--dry-run]')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = cliArgs(process.argv.slice(2))
    const result = args.dryRun
      ? { ok: true, mode: 'dry-run', stateDir: args.stateDir, dbPath: args.dbPath || join(args.stateDir, 'ria.sqlite') }
      : migrateDomains(args)
    console.log(JSON.stringify(result, null, 2))
    if (result.ok === false) process.exitCode = 1
  } catch (cause) {
    console.error(JSON.stringify({ ok: false, code: cause.code || 'error', message: cause.message }))
    process.exitCode = 1
  }
}
