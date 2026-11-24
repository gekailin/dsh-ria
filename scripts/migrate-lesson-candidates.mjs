#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SCHEMA_SQL } from '../lib/state/sqlite/schema.mjs'
import { importLessonCandidates } from '../lib/state/sqlite/lesson-candidates.mjs'

const stateDir = process.env.RIA_STATE_DIR || process.argv[2] || join(process.env.HOME || '.', '.dsh', 'state', 'ria')
const dbPath = process.env.RIA_DB || process.argv[3] || join(stateDir, 'ria.sqlite')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backups = join(stateDir, 'lesson-candidates-backup-' + stamp)
if (!existsSync(stateDir) || !existsSync(dbPath)) { console.error('missing stateDir/db: ' + stateDir + ' ' + dbPath); process.exit(2) }
mkdirSync(backups, { recursive: true })
copyFileSync(dbPath, join(backups, 'ria.sqlite.bak'))
if (existsSync(join(stateDir, 'events.jsonl'))) copyFileSync(join(stateDir, 'events.jsonl'), join(backups, 'events.jsonl.bak'))
for (const name of readdirSync(stateDir).filter(name => /^events-\d{8}T\d{6}\.jsonl$/.test(name))) copyFileSync(join(stateDir, name), join(backups, name + '.bak'))
const db = openDatabase(dbPath, { create: false })
db.exec(SCHEMA_SQL)
const result = importLessonCandidates({ db, stateDir })
db.close()
console.log(JSON.stringify({ stateDir, dbPath, backups, ...result }, null, 2))
