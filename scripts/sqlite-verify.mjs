#!/usr/bin/env node
// Read-only SQLite health check for the Ria state.
//
// Usage:
//   node scripts/sqlite-verify.mjs --state-dir <stateDir> [--db <path>] [--sample 20]
//
// The DB is checked against itself with pure SQL. legacy ria.json is only an
// informational comparison after Phase A froze it; it never affects ok/exit.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { readStateSource } from '../lib/state/sqlite/source.mjs'
import { checkDomainTables, checkIntegrity, checkSelfConsistency, compareCounts } from '../lib/state/sqlite/verify.mjs'

const error = (code, message) => Object.assign(new Error(message), { code })

function legacyComparison(stateDir, counts) {
  try {
    const source = readStateSource(stateDir)
    const compared = compareCounts(counts, source.counts)
    return { informational: true, available: true, matched: compared.ok, deltas: compared.mismatches }
  } catch (cause) {
    return { informational: true, available: false, matched: false, deltas: [], message: String(cause && cause.message ? cause.message : cause) }
  }
}

export function verifySqliteState({ stateDir, dbPath = join(stateDir, 'ria.sqlite') } = {}) {
  if (!stateDir) throw error('invalid_arguments', 'stateDir is required')
  if (!existsSync(dbPath)) throw error('sqlite_missing', 'SQLite DB is missing: ' + dbPath)
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    const adapter = new SqliteTicketAdapter(db)
    const counts = adapter.counts()
    const selfConsistency = checkSelfConsistency(db)
    const integrity = checkIntegrity(db)
    const domains = checkDomainTables(db)
    const issues = [...selfConsistency.issues]
    if (!integrity.ok) issues.push('integrity check failed: integrity=' + JSON.stringify(integrity.integrity) + ' foreignKeys=' + integrity.foreignKeys.length + ' orphanHistory=' + integrity.orphanHistory)
    if (!domains.ok) issues.push('domains check failed: issues=' + JSON.stringify(domains.issues))
    return {
      ok: selfConsistency.ok && integrity.ok && domains.ok,
      mode: 'verify-only',
      dbPath,
      counts,
      countsMatch: selfConsistency.ok,
      selfConsistency,
      issues,
      integrity: integrity.integrity,
      foreignKeyViolations: integrity.foreignKeys.length,
      orphanHistory: integrity.orphanHistory,
      domains,
      legacyComparison: legacyComparison(stateDir, counts),
    }
  } finally { db.close() }
}

export function verificationFailed(result) {
  return result.ok === false || (result.selfConsistency && result.selfConsistency.ok === false)
    || (Array.isArray(result.issues) && result.issues.length > 0)
    || !Array.isArray(result.integrity) || result.integrity.some(value => value !== 'ok')
    || result.foreignKeyViolations > 0 || result.orphanHistory > 0
    || (result.domains && result.domains.ok === false)
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
