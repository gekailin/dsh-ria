import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// Scope=recent used to stop at 10. Build 25 recent sessions and make sure the
// host now returns the raised cap, newest first, without leaking the 21st.
const extraSessions = []
const fixture = await createFixture({ extraSessions })
try {
  for (let index = 0; index < 25; index += 1) {
    extraSessions.push({
      sessionId: 'session-recent-' + index,
      running: false,
      blank: false,
      updatedAt: 100 + index,
      cwd: fixture.stateDir,
    })
  }
  const records = fixture.service.store.recentWorkers()
  const base = Date.now()
  for (let index = 0; index < extraSessions.length; index += 1) {
    records[extraSessions[index].sessionId] = { lastUsedAt: base - index * 1000 }
  }

  const recent = await fixture.call('ria_status', { scope: 'recent' })
  assert.equal(recent.limit, 20)
  assert.equal(recent.windowDays, 7)
  assert.equal(recent.workers.length, 20)
  assert.deepEqual(
    recent.workers.map(item => item.sessionId),
    extraSessions.slice(0, 20).map(item => item.sessionId),
  )
  assert.equal(recent.workers.some(item => item.sessionId === 'session-recent-20'), false)
} finally {
  fixture.cleanup()
}

console.log('recent workers ok')
