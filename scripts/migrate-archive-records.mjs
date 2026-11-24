#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { cleanupArchiveRecords, rollbackArchiveRecords } from '../lib/state/sqlite/archive-records.mjs'

const args = process.argv.slice(2)
const stateDir = process.env.RIA_STATE_DIR || args.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length) || join(process.env.HOME || '.', '.dsh', 'state', 'ria')
const dbPath = process.env.RIA_DB || join(stateDir, 'ria.sqlite')
const apply = args.includes('--apply')
const rollback = args.includes('--rollback')
const runArg = args.find(arg => arg.startsWith('--run-id='))
const runId = runArg ? runArg.slice('--run-id='.length) : null
if (!existsSync(dbPath)) { console.error(JSON.stringify({ ok: false, code: 'sqlite_missing', dbPath })); process.exit(2) }
const db = openDatabase(dbPath)
try {
  const result = rollback ? rollbackArchiveRecords(db, { stateDir, runId }) : cleanupArchiveRecords(db, { apply, stateDir, runId })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
} finally { db.close() }
