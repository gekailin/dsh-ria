import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()
try {
  const renamed = await fixture.call('ria_title', { sessionId: 'session-worker', title: 'Renamed Worker' })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.sessionId, 'session-worker')
  assert.equal(renamed.title, 'Renamed Worker')
  assert.equal(renamed.previous, 'Worker One')
  assert.deepEqual(fixture.renames.at(-1), { sessionId: 'session-worker', title: 'Renamed Worker' })
  assert.equal(fixture.prompts.length, 0)

  const sessions = await fixture.call('ria_status', { scope: 'sessions' })
  assert.equal(sessions.sessions.find(item => item.sessionId === 'session-worker').title, 'Renamed Worker')

  const beforeMissing = fixture.renames.length
  const missing = await fixture.call('ria_title', { sessionId: 'session-missing', title: 'No One' })
  assert.deepEqual([missing.ok, missing.code, missing.sessionId], [false, 'session_missing', 'session-missing'])
  assert.equal(fixture.renames.length, beforeMissing)

  const subagent = await fixture.call('ria_title', { sessionId: 'session-subagent', title: 'Child' })
  assert.deepEqual([subagent.ok, subagent.code], [false, 'not_top_level'])
  assert.equal(fixture.renames.length, beforeMissing)

  const beforeInvalid = fixture.renames.length
  const invalid = await fixture.call('ria_title', { sessionId: 'session-worker', title: '\u0007' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'title_invalid')
  assert.equal(invalid.message, 'session title must contain visible characters')
  assert.equal(fixture.renames.length, beforeInvalid + 1)
  const afterInvalid = await fixture.call('ria_status', { scope: 'sessions' })
  assert.equal(afterInvalid.sessions.find(item => item.sessionId === 'session-worker').title, 'Renamed Worker')

  const selfRenamed = await fixture.call('ria_title', { sessionId: fixture.riaAgent.id, title: 'Ria Renamed' })
  assert.equal(selfRenamed.ok, true)
  assert.equal(selfRenamed.sessionId, fixture.riaAgent.id)
  assert.equal(selfRenamed.title, 'Ria Renamed')
  assert.equal(selfRenamed.previous, 'Ria')
} finally {
  fixture.cleanup()
}

const archivedFixture = await createFixture({ archivedSessionIds: ['session-worker'] })
try {
  const before = archivedFixture.renames.length
  const archived = await archivedFixture.call('ria_title', { sessionId: 'session-worker', title: 'Archived Rename' })
  assert.deepEqual([archived.ok, archived.code], [false, 'session_archived'])
  assert.equal(archivedFixture.renames.length, before)
} finally {
  archivedFixture.cleanup()
}

console.log('title ok')
