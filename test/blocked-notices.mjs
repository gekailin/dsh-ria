import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Blocking notices now cover watched sessions only. Unwatched ordinary sessions
// are traced with notice.suppressed instead of paging the Chat.

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-watched', running: false, blank: false, updatedAt: 10, cwd: '/tmp', projections: { values: { title: 'Alpha Session' } } },
    { sessionId: 'session-unwatched', running: false, blank: false, updatedAt: 9, cwd: '/tmp', projections: { values: { title: 'Beta Session' } } },
  ],
})
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const chat = fixture.service.controller.state.chatSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chat)).map(item => String(item.content[0].text))
const events = () => fixture.service.routerEvents.query({ limit: 200 }).events
const approval = (sessionId, callId = 'call-1') => ({
  agent: { id: sessionId }, toolName: 'bash', callId, reason: 'read only', signal: new AbortController().signal,
})
const question = (sessionId, id = 'q1') => ({
  agent: { id: sessionId }, questions: [{ id, question: '要现在部署吗？' }], signal: new AbortController().signal,
})

try {
  fixture.service.controller.coManagement.add({ sessionId: 'session-watched', title: 'Alpha Session' })
  await fixture.emit('tools/pre-execute', { agent: { id: 'session-watched' }, name: 'bash', callId: 'call-1', arguments: { command: 'git status' } }, async () => ({ kind: 'enter' }))

  // Watched approval: exactly one co-management notice, no generic duplicate.
  const before = notices().length
  const approved = await fixture.emit('approval/request', approval('session-watched'), async () => 'rejected')
  assert.equal(approved, 'allowed-once')
  await settle()
  const approvalNotices = notices().slice(before)
  assert.equal(approvalNotices.filter(text => text.includes('【协管·Alpha Session】已自动放行低风险提权')).length, 1)
  assert.equal(approvalNotices.filter(text => text.includes('需要你决定的提权')).length, 0)

  // Watched question: one notice, and the same question id is deduped.
  const beforeQuestion = notices().length
  await fixture.emit('user-questions/request', question('session-watched'), async () => ({ answers: [] }))
  await settle()
  assert.equal(notices().slice(beforeQuestion).filter(text => text.includes('【协管·Alpha Session】在等你回答')).length, 1)
  await fixture.emit('user-questions/request', question('session-watched'), async () => ({ answers: [] }))
  await settle()
  assert.equal(notices().length, beforeQuestion + 1)

  // Unwatched ordinary session: no Chat notice, but one suppressed event.
  const quiet = notices().length
  await fixture.emit('approval/request', approval('session-unwatched'), async () => 'rejected')
  await fixture.emit('user-questions/request', question('session-unwatched'), async () => ({ answers: [] }))
  await settle()
  assert.equal(notices().length, quiet)
  const suppressed = events().filter(item => item.event === 'notice.suppressed' && item.sessionId === 'session-unwatched')
  assert.ok(suppressed.some(item => item.payload && item.payload.kind === 'approval' && item.payload.toolName === 'bash'))
  assert.ok(suppressed.some(item => item.payload && item.payload.kind === 'question'))

  // Role sessions are silent and do not create suppressed events.
  const advisor = await fixture.advisorSession()
  const executor = (await fixture.service.controller.ensureExecutor('global')).sessionId
  for (const id of [chat, advisor, executor]) {
    const beforeNotice = notices().length
    const beforeEvent = events().length
    await fixture.emit('user-questions/request', question(id, 'role-q'), async () => ({ answers: [] }))
    await settle()
    assert.equal(notices().length, beforeNotice)
    assert.equal(events().length, beforeEvent)
  }

  console.log('state blocked notices ok')
} finally {
  fixture.cleanup()
}
