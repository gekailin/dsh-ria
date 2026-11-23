import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LESSON_COGNITION_MAP, migrateLessonsToCognition } from '../lib/state/cognition-migration.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-cognition-migration-'))
try {
  const stateDir = join(root, 'state'); writeFileSync(stateDir + '.tmp', '')
  const { mkdirSync } = await import('node:fs'); mkdirSync(stateDir, { recursive: true })
  const lessons = [
    { id: 'les_mwmokkvc_6952416e', scenario: 'deploy dispatch', pitfall: 'p1', approach: 'a1', ticket_id: 't1' },
    { id: 'les_mwmokkvi_889cb8cd', scenario: 'approval flow', pitfall: 'p2', approach: 'a2' },
    { id: 'les_mwmokkvp_468aa38e', scenario: 'approval timeout', pitfall: 'p3', approach: 'a3' },
    { id: 'les_mwmokkvt_85ab2c55', scenario: 'deploy reload', pitfall: 'p4', approach: 'a4' },
    { id: 'les_mwmorazz_c3ab1775', scenario: 'risk wait', pitfall: 'p5', approach: 'a5' },
    { id: 'les_mwmorb05_0bd4388f', scenario: 'audit exactly once', pitfall: 'p6', approach: 'a6' },
    { id: 'les_mwmp7jvy_26cf4022', scenario: 'state event', pitfall: 'p7', approach: 'a7' },
    { id: 'les_mwmp7jw4_fd672b60', scenario: 'http exact path', pitfall: 'p8', approach: 'a8' },
  ]
  const first = migrateLessonsToCognition({ stateDir, lessons, now: 1000 })
  assert.equal(first.migrated, 8)
  assert.ok(first.backupDir && readdirSync(stateDir).some(name => name.startsWith('cognition.bak.')))
  for (const id of Object.keys(LESSON_COGNITION_MAP)) {
    const target = join(stateDir, 'cognition', 'chat', LESSON_COGNITION_MAP[id].file)
    assert.ok(readFileSync(target, 'utf8').includes('<!-- lesson:' + id + ' -->'), id)
  }
  const second = migrateLessonsToCognition({ stateDir, lessons, now: 2000 })
  assert.equal(second.migrated, 0)
  assert.equal(second.backupDir, null)
  assert.equal(readdirSync(stateDir).filter(name => name.startsWith('cognition.bak.')).length, 1)
  console.log('cognition migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }
