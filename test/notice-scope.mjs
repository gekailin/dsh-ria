import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  stateDefault: true,
  extraSessions: [
    { sessionId: 'session-unwatched', running: false, blank: false, updatedAt: 5, cwd: '/tmp', projections: { values: { title: 'Unwatched' } } },
    { sessionId: 'session-watched', running: false, blank: false, updatedAt: 6, cwd: '/tmp', projections: { values: { title: 'Watched' } } },
  ],
})
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
try {
  const controller = fixture.service.controller
  const chat = fixture.service.controller.state.chatSessionId
  const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chat)).map(item => String(item.content[0].text))
  const events = () => fixture.service.routerEvents.query({ limit: 200 }).events
  const suppressed = kind => events().filter(item => item.event === 'notice.suppressed' && item.payload && item.payload.kind === kind)

  // Unwatched ordinary session: question and approval are silent but traced.
  let before = notices().length
  await fixture.emit(
    'user-questions/request',
    { agent: { id: 'session-unwatched' }, questions: [{ id: 'q-unwatched', question: 'which option?' }], signal: new AbortController().signal },
    async () => ({ answers: [] }),
  )
  await settle()
  assert.equal(notices().length, before)
  const qEvents = suppressed('question').filter(item => item.sessionId === 'session-unwatched')
  assert.equal(qEvents.length, 1, JSON.stringify(events()))
  assert.match(qEvents[0].payload.question, /which option/)

  await fixture.emit('tools/pre-execute', { agent: { id: 'session-unwatched' }, name: 'bash', callId: 'unwatched-approval', arguments: { command: 'git status' } }, async () => ({ kind: 'enter' }))
  before = notices().length
  await fixture.emit(
    'approval/request',
    { agent: { id: 'session-unwatched' }, toolName: 'bash', callId: 'unwatched-approval', reason: 'read', signal: new AbortController().signal },
    async () => 'rejected',
  )
  await settle()
  assert.equal(notices().length, before + 1)
  assert.ok(String(notices().at(-1)).includes('#session-unwatched 等待审批：bash'))
  const aEvents = suppressed('approval').filter(item => item.sessionId === 'session-unwatched')
  assert.equal(aEvents.length, 0, JSON.stringify(events()))

  // Watched session: only the co-management notice, never the generic one.
  controller.coManagement.add({ sessionId: 'session-watched', title: 'Watched' })
  before = notices().length
  await fixture.emit(
    'user-questions/request',
    { agent: { id: 'session-watched' }, questions: [{ id: 'q-watched', question: 'which watched option?' }], signal: new AbortController().signal },
    async () => ({ answers: [] }),
  )
  await settle()
  const questionNotices = notices().slice(before)
  assert.equal(questionNotices.filter(text => text.includes('【协管·Watched】在等你回答')).length, 1)
  assert.equal(questionNotices.filter(text => text.includes('需要你')).length, 0)
  assert.equal(suppressed('question').some(item => item.sessionId === 'session-watched'), false)

  await fixture.emit('tools/pre-execute', { agent: { id: 'session-watched' }, name: 'bash', callId: 'watched-approval', arguments: { command: 'git status' } }, async () => ({ kind: 'enter' }))
  before = notices().length
  const watchedApproval = await fixture.emit(
    'approval/request',
    { agent: { id: 'session-watched' }, toolName: 'bash', callId: 'watched-approval', reason: 'read', signal: new AbortController().signal },
    async () => 'rejected',
  )
  await settle()
  assert.equal(watchedApproval, 'allowed-once')
  const approvalNotices = notices().slice(before)
  assert.equal(approvalNotices.filter(text => text.includes('【协管·Watched】已自动放行低风险提权')).length, 1)
  assert.equal(approvalNotices.filter(text => text.includes('需要你决定的提权')).length, 0)
  assert.equal(suppressed('approval').some(item => item.sessionId === 'session-watched'), false)

  // Role sessions remain silent with no suppressed event.
  const advisor = await fixture.advisorSession()
  const executor = (await controller.ensureExecutor('global')).sessionId
  for (const id of [chat, advisor, executor]) {
    before = notices().length
    const beforeEvents = events().length
    await fixture.emit(
      'user-questions/request',
      { agent: { id }, questions: [{ id: 'q-role', question: 'role question?' }], signal: new AbortController().signal },
      async () => ({ answers: [] }),
    )
    await settle()
    assert.equal(notices().length, before)
    assert.equal(events().length, beforeEvents)
  }

  console.log('state notice scope ok')
} finally {
  fixture.cleanup()
}
