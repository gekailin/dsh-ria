import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeReflectionRun,
  reflectionFileNames,
  reflectionManualPath,
  reflectionPaths,
  reflectionReportPath,
  reflectionRunOrdinal,
  reflectionTitle,
  writeReflectionRun,
} from '../lib/reflection.mjs'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-reflection-naming-'))

try {
  const date = '2026-11-14'
  assert.equal(reflectionTitle(date), '反思 ' + date)
  assert.equal(reflectionTitle(date, 2), '反思 ' + date + '（第2次）')
  assert.equal(reflectionTitle(date, 3), '反思 ' + date + '（第3次）')
  assert.equal(reflectionTitle(date, 1), '反思 ' + date)
  assert.throws(() => reflectionTitle('2026-11-31'), /invalid reflection date/)
  assert.throws(() => reflectionTitle('not-a-date'), /invalid reflection date/)

  assert.deepEqual(reflectionFileNames(date), {
    final: date + '.md',
    partial: date + '.partial.md',
    manualPrefix: date + '.manual-',
  })

  const runId = 'refl-20261114-abcdef'
  const paths = reflectionPaths(stateDir, date, { runId })
  assert.deepEqual(paths, {
    root: join(stateDir, 'reflections'),
    final: join(stateDir, 'reflections', date + '.md'),
    partial: join(stateDir, 'reflections', date + '.partial.md'),
    manualPrefix: join(stateDir, 'reflections', date + '.manual-'),
    runsDir: join(stateDir, 'reflections', 'runs'),
    runDir: join(stateDir, 'reflections', 'runs', runId),
    runFile: join(stateDir, 'reflections', 'runs', runId, 'run.json'),
    draft: join(stateDir, 'reflections', 'runs', runId, 'report.partial.md'),
    state: join(stateDir, 'reflections', 'state.json'),
    lock: join(stateDir, 'reflections', '.lock'),
  })

  const run = makeReflectionRun({
    runId,
    forDate: date,
    createdAt: Date.parse('2026-11-14T10:00:00+08:00'),
  }, { stateDir })
  assert.equal(run.ordinal, 1)
  assert.equal(run.title, reflectionTitle(date))
  assert.equal(run.reportFinal, paths.final)
  assert.equal(run.reportPartial, paths.draft)
  assert.equal(reflectionReportPath(run, 'complete'), paths.final)
  assert.equal(reflectionReportPath(run, 'partial'), paths.partial)
  writeReflectionRun(run, stateDir)
  assert.equal(reflectionRunOrdinal(stateDir, date), 2)

  const second = makeReflectionRun({
    runId: 'refl-20261114-bcdef0',
    forDate: date,
    ordinal: 2,
    createdAt: Date.parse('2026-11-14T11:00:00+08:00'),
  }, { stateDir })
  assert.equal(second.ordinal, 2)
  assert.equal(second.title, reflectionTitle(date, 2))
  writeReflectionRun(second, stateDir)
  assert.equal(reflectionRunOrdinal(stateDir, date), 3)

  const other = makeReflectionRun({
    runId: 'refl-20261115-abcdef',
    forDate: '2026-11-15',
    createdAt: Date.parse('2026-11-15T10:00:00+08:00'),
  }, { stateDir })
  writeReflectionRun(other, stateDir)
  assert.equal(reflectionRunOrdinal(stateDir, date), 3)
  assert.equal(reflectionRunOrdinal(stateDir, '2026-11-15'), 2)

  const brokenDir = join(paths.runsDir, 'refl-20261114-broken')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'run.json'), '{not json')
  assert.equal(reflectionRunOrdinal(stateDir, date), 3)

  const manualAt = Date.parse('2026-11-14T10:23:00+08:00')
  const manual = reflectionManualPath(stateDir, date, manualAt)
  assert.equal(manual, join(stateDir, 'reflections', date + '.manual-1023.md'))
  writeFileSync(manual, 'existing')
  assert.equal(
    reflectionManualPath(stateDir, date, manualAt),
    join(stateDir, 'reflections', date + '.manual-1023-2.md'),
  )

  const shanghai = makeReflectionRun({
    createdAt: Date.parse('2026-11-13T17:30:00Z'),
  }, { stateDir })
  assert.equal(shanghai.forDate, '2026-11-14')
  assert.match(shanghai.runId, /^refl-20261114-[0-9a-f]{6}$/)
  assert.equal(shanghai.title, reflectionTitle('2026-11-14'))
  assert.equal(shanghai.reportFinal, join(stateDir, 'reflections', '2026-11-14.md'))

  console.log('reflection-naming ok')
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}
