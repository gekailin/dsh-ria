import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SCHEMA_SQL } from '../lib/state/sqlite/schema.mjs'
import { importLessonCandidates, LESSON_CANDIDATE_IMPORT_MARKER } from '../lib/state/sqlite/lesson-candidates.mjs'
import { checkSelfConsistency } from '../lib/state/sqlite/verify.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-lc-store-'))
try {
  const db = openDatabase(join(root, 'state.sqlite'), { create: true })
  const store = new StateStore(root)
  store.sqliteRuntime = { db }
  store.addLessonCandidate({ id: 'lc_pending', scope: 'project:dsh-ria', body: 'candidate body', cause: 'cause', sources: [{ type: 'file', ref: 'x' }], status: 'pending' })
  store.addLessonCandidate({ id: 'lc_accepted', body: 'accepted body', sources: [{ type: 'file', ref: 'x' }], status: 'accepted' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cognition_lesson_candidates').get().n, 2)
  assert.equal(store.lessonCandidates({ status: 'pending' }).some(item => item.id === 'lc_pending'), true)
  assert.equal(store.lessonCandidates({ status: 'accepted' }).some(item => item.id === 'lc_accepted'), true)
  if (existsSync(join(root, 'events.jsonl'))) assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8').includes('lesson.candidate'), false)

  const dir = mkdtempSync(join(tmpdir(), 'ria-lc-migrate-'))
  try {
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ kind: 'lesson.candidate', payload: { id: 'lc_evt', body: 'event body', sources: [{ type: 'file', ref: 'e' }], at: 1 } }) + '\n')
    const mdb = openDatabase(join(dir, 'm.sqlite'), { create: true })
    mdb.exec(SCHEMA_SQL)
    const first = importLessonCandidates({ db: mdb, stateDir: dir, now: 10 })
    assert.equal(first.inserted, 1)
    assert.ok(mdb.prepare('SELECT 1 FROM schema_meta WHERE key=?').get(LESSON_CANDIDATE_IMPORT_MARKER))
    const second = importLessonCandidates({ db: mdb, stateDir: dir, now: 11 })
    assert.equal(second.inserted, 0)
    assert.equal(second.skipped, true)
    mdb.exec('PRAGMA ignore_check_constraints=ON')
    mdb.prepare("INSERT INTO cognition_lesson_candidates(id,body,sources,status,created_at,updated_at) VALUES('bad','x','[]','bogus',1,1)").run()
    const verify = checkSelfConsistency(mdb)
    assert.equal(verify.ok, false)
    assert.ok(verify.issues.some(item => item.includes('R6a_lesson_candidate_status')))
    mdb.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log('lesson candidates ok')
} finally { rmSync(root, { recursive: true, force: true }) }