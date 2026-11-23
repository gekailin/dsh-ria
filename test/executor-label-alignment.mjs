import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { alignExecutorLabels } from '../lib/state/executor-label-alignment.mjs'
import { executorDisplayLabel, roleExecutorTitle, roleSessionTitle } from '../lib/core/controller.mjs'

// 1) One-off alignment: only executorLabel changes, events.jsonl is untouched,
//    and a second run is a byte-for-byte no-op with no new backup.
{
  const root = mkdtempSync(join(tmpdir(), 'ria-executor-label-align-'))
  try {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const statePath = join(stateDir, 'state.json')
    const eventsPath = join(stateDir, 'events.jsonl')
    const before = {
      schemaVersion: 1,
      executors: {
        'session-a': { sessionId: 'session-a', executorType: 'work', seq: 1, executorLabel: 'Ria Worker 1', cwd: '/work/a' },
        'session-b': { sessionId: 'session-b', executorType: 'work', seq: 2, executorLabel: '', cwd: '/work/b' },
        'session-c': { sessionId: 'session-c', executorType: 'work', seq: 3, executorLabel: 'keep-me', cwd: '/work/c' },
      },
      meta: { executorSeq: 3, reflectionSeq: 0 },
      chatSessionId: 'session-chat',
    }
    writeFileSync(statePath, JSON.stringify(before, null, 2) + '\n')
    const eventsText = [
      JSON.stringify({ at: 1, kind: 'worker.state.changed', payload: { workerId: 'session-a', workerLabel: 'Ria Worker 1' } }),
      '{not valid json',
      '',
    ].join('\n')
    writeFileSync(eventsPath, eventsText)
    const eventsHash = createHash('sha256').update(readFileSync(eventsPath)).digest('hex')
    const eventsMtime = statSync(eventsPath).mtimeMs
    const titles = { 'session-a': 'Ria Executor 1', 'session-b': 'Ria 文档', 'session-c': '' }
    const resolveTitle = sessionId => titles[sessionId] || ''

    // dry-run: report only
    const dry = await alignExecutorLabels({ stateDir, resolveTitle, dryRun: true })
    assert.equal(dry.changed, true)
    assert.equal(dry.updated, 2)
    assert.equal(dry.backupFile, null)
    assert.deepEqual(readFileSync(statePath, 'utf8'), JSON.stringify(before, null, 2) + '\n')
    assert.equal(readdirSync(stateDir).some(name => name.includes('.bak.')), false)

    // real run: backup + only labels change
    const first = await alignExecutorLabels({ stateDir, resolveTitle })
    assert.equal(first.changed, true)
    assert.equal(first.updated, 2)
    assert.ok(first.backupFile && first.backupFile.includes('.bak.'))
    assert.deepEqual(JSON.parse(readFileSync(first.backupFile, 'utf8')), before)
    const after = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(after.executors['session-a'].executorLabel, 'Ria Executor 1')
    assert.equal(after.executors['session-b'].executorLabel, 'Ria 文档')
    assert.equal(after.executors['session-c'].executorLabel, 'keep-me')
    for (const id of ['session-a', 'session-b', 'session-c']) {
      const expected = { ...before.executors[id] }
      expected.executorLabel = after.executors[id].executorLabel
      assert.deepEqual(after.executors[id], expected)
    }
    assert.deepEqual(after.meta, before.meta)
    assert.equal(after.chatSessionId, before.chatSessionId)

    // events.jsonl must be byte-identical and not even touched
    assert.equal(createHash('sha256').update(readFileSync(eventsPath)).digest('hex'), eventsHash)
    assert.equal(statSync(eventsPath).mtimeMs, eventsMtime)

    // second run: no changes, no new backup, same bytes
    const stateBytes = readFileSync(statePath)
    const second = await alignExecutorLabels({ stateDir, resolveTitle })
    assert.equal(second.changed, false)
    assert.equal(second.updated, 0)
    assert.deepEqual(readFileSync(statePath), stateBytes)
    assert.equal(readdirSync(stateDir).filter(name => name.includes('.bak.')).length, 1)

    // fallback display semantics: live title wins; stored label is the fallback
    assert.equal(executorDisplayLabel({ executorLabel: 'Ria Worker 1', executorType: 'work', seq: 1 }, 'Ria Executor 1'), 'Ria Executor 1')
    assert.equal(executorDisplayLabel({ executorLabel: 'Ria Worker 1', executorType: 'work', seq: 1 }, ''), 'Ria Worker 1')
    assert.equal(executorDisplayLabel({ executorType: 'work', seq: 7 }, ''), 'Ria Executor 7')
    assert.equal(roleExecutorTitle('work', 7), 'Ria Executor 7')
    assert.equal(roleSessionTitle('reflection', 3), 'Ria Reflection Executor 3')
    console.log('executor label alignment ok')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// 2) Live controller: rename the Session title and the persisted executorLabel
//    follows on read; a bulk sync also follows it.
{
  const fixture = await createFixture({ state: true })
  try {
    const controller = fixture.service.controller
    const created = await controller.ensureExecutor('global')
    const id = created.sessionId
    assert.match(controller.state.executor(id).executorLabel, /^Ria Executor \d+$/)
    assert.equal(controller.state.executor(id).executorLabel, created.meta.executorLabel)

    await fixture.service.ctx.sessionController.rename({ sessionId: id, title: '自定义 Executor 标题' })
    const view = await controller.executorConfigView(controller.state.executor(id))
    assert.equal(view.title, '自定义 Executor 标题')
    assert.equal(controller.state.executor(id).executorLabel, '自定义 Executor 标题')

    await fixture.service.ctx.sessionController.rename({ sessionId: id, title: 'Ria Executor 99' })
    const synced = await controller.syncExecutorLabels()
    assert.equal(synced.checked >= 1, true)
    assert.equal(synced.updated >= 1, true)
    assert.equal(controller.state.executor(id).executorLabel, 'Ria Executor 99')

    // Idempotent: a second sync reports no planned changes for this executor.
    const again = await controller.syncExecutorLabels()
    assert.equal(again.planned, 0)
    assert.equal(controller.state.executor(id).executorLabel, 'Ria Executor 99')
    console.log('executor label follows session title ok')
  } finally { fixture.cleanup() }
}
