#!/usr/bin/env node
// Read-only SQLite health check for the Ria state.
//
// Usage:
//   node scripts/sqlite-verify.mjs --state-dir <stateDir> [--db <path>] [--sample 20]
//
// Opens ria.sqlite read-only, compares it with the JSON sources, and reports
// counts / integrity / sample mismatches. It never writes to the database or
// the JSON state.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { readStateSource } from '../lib/state/sqlite/source.mjs'
import { verifyDatabase } from '../lib/state/sqlite/verify.mjs'

const error = (code, message) => Object.assign(new Error(message), { code })

function describe(verification) {
  return {
    ok: verification.ok,
    counts: verification.counts.actual,
    countsMatch: verification.counts.ok,
    integrity: verification.integrity.integrity,
    foreignKeyViolations: verification.integrity.foreignKeys.length,
    orphanHistory: verification.integrity.orphanHistory,
    sampled: verification.sample.sampled,
    sampleMismatches: verification.sample.results.filter(result => !result.ok),
    importId: verification.provenance.importId,
    sourceSha256: verification.provenance.sourceSha256,
  }
}

export function verifySqliteState({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), sampleSize = 20 } = {}) {
  if (!stateDir) throw error('invalid_arguments', 'stateDir is required')
  if (!existsSync(dbPath)) throw error('sqlite_missing', 'SQLite DB is missing: ' + dbPath)
  const source = readStateSource(stateDir)
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    const verification = verifyDatabase(db, new SqliteTicketAdapter(db), source, { sampleSize, requireSourceHash: false })
    return { ok: verification.ok, mode: 'verify-only', dbPath, ...describe(verification) }
  } finally {
    db.close()
  }
}

export function verificationFailed(result) {
  return result.ok === false || result.countsMatch === false
    || (Array.isArray(result.sampleMismatches) && result.sampleMismatches.length > 0)
    || !Array.isArray(result.integrity) || result.integrity.some(value => value !== 'ok')
    || result.foreignKeyViolations > 0 || result.orphanHistory > 0
}

export function cliArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--state-dir') result.stateDir = argv[++index]
    else if (arg === '--db') result.dbPath = argv[++index]
    else if (arg === '--sample') result.sampleSize = Number(argv[++index])
    else if (arg === '--verify-only') continue
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/sqlite-verify.mjs --state-dir <stateDir> [--db <path>] [--sample 20]\n')
      process.exit(0)
    } else throw new Error('Unknown argument: ' + arg)
  }
  if (!result.stateDir) throw new Error('Usage: node scripts/sqlite-verify.mjs --state-dir <stateDir> [--db <path>] [--sample 20]')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifySqliteState(cliArgs(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (verificationFailed(result)) process.exitCode = 1
  } catch (cause) {
    console.error(JSON.stringify({ ok: false, code: cause.code || 'error', message: cause.message }))
    process.exitCode = 1
  }
}
