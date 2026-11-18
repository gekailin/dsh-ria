import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

// Restricted sessions stopped for a human are visible in the Chatbot channel as
// one short notice. The notice is read-only: these tests also prove the plugin
// never answers the approval or the question.

const independentCwd = mkdtempSync(join(tmpdir(), 'ria-independent-'))
const fixture = await createFixture({
  v2Default: true,
  extraSessions: [
    { sessionId: 'session-independent', running: false, blank: false, updatedAt: 10, cwd: independentCwd, projections: { values: { title: 'Alpha Session' } } },
    { sessionId: 'session-other', running: false, blank: false, updatedAt: 9, cwd: independentCwd, projections: { values: { title: 'Beta Session' } } },
    // Not ordinary sessions: a subagent row, and session-worker/list entries that
    // live under the Ria state directory.
    { sessionId: 'session-subagent-row', running: false, blank: false, origin: 'subagent', updatedAt: 8, cwd: independentCwd },
  ],
})

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const chatbot = fixture.service.v2.v2.chatbotSessionId
const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot))
const bodyOf = prompt => String(prompt && prompt.content && prompt.content[0] ? prompt.content[0].text : '')
const approval = (sessionId, overrides = {}) => ({
  agent: { id: sessionId },
  toolName: 'bash',
  callId: 'c1',
  reason: 'write outside workspace',
  signal: new AbortController().signal,
  ...overrides,
})
const question = (sessionId, overrides = {}) => ({
  agent: { id: sessionId },
  questions: [{ id: 'q1', header: '确认', question: '要现在部署吗？' }],
  signal: new AbortController().signal,
  ...overrides,
})
const allowOnce = async () => 'allowed-once'
const answerYes = async () => ({ answers: [{ id: 'q1', selected: ['是'] }] })

try {
  await fixture.service.ensure()
  assert.ok(chatbot)

  // A turn boundary is what makes the "how long has it been waiting" clause
  // available; without it the notice still goes out, just shorter.
  fixture.service.onSessionEvent({ header: { id: 'session-independent' } }, { type: 'turn/start', data: { turn: 1 } })

  const before = notices().length
  const approved = await fixture.emit('approval/request', approval('session-independent'), allowOnce)
  // The outcome is whatever the downstream answerer returned: this plugin never
  // decides an approval.
  assert.equal(approved, 'allowed-once')
  await settle()
  const first = notices().slice(before)
  assert.equal(first.length, 1)
  assert.match(bodyOf(first[0]), /Alpha Session/)
  assert.match(bodyOf(first[0]), /bash/)
  assert.match(bodyOf(first[0]), /write outside workspace/)
  assert.match(bodyOf(first[0]), /本轮已运行 \d+s/)
  assert.match(bodyOf(first[0]), /Ria 不代答/)

  // The same request observed again (another emit, another browser retry) is
  // deduped by session + kind + signature.
  await fixture.emit('approval/request', approval('session-independent', { callId: 'c2' }), allowOnce)
  await settle()
  assert.equal(notices().length, before + 1)

  // A different reason is a different signature, but the per-session flood
  // guard still keeps one notice per minute.
  assert.equal(fixture.service.v2.blockedNoticeMinIntervalMs, 60_000)
  await fixture.emit('approval/request', approval('session-independent', { reason: 'network access' }), allowOnce)
  await settle()
  assert.equal(notices().length, before + 1)

  // Once the request settles the key is cleared, so the next block notifies.
  fixture.service.onSessionEvent({ header: { id: 'session-independent' } }, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  fixture.service.v2.blockedNoticeMinIntervalMs = 0
  await fixture.emit('approval/request', approval('session-independent', { reason: 'network access' }), allowOnce)
  await settle()
  assert.equal(notices().length, before + 2)

  // Another ordinary session gets its own notice and its own title.
  await fixture.emit('approval/request', approval('session-other'), allowOnce)
  await settle()
  assert.equal(notices().length, before + 3)
  assert.match(bodyOf(notices().at(-1)), /Beta Session/)

  // Workers, the Chatbot itself and subagent rows are not ordinary independent
  // sessions: no notice, and the request still reaches the next answerer.
  const quiet = notices().length
  assert.equal(await fixture.emit('approval/request', approval('session-worker'), allowOnce), 'allowed-once')
  assert.equal(await fixture.emit('approval/request', approval(chatbot), allowOnce), 'allowed-once')
  assert.equal(await fixture.emit('approval/request', approval('session-subagent-row'), allowOnce), 'allowed-once')
  await settle()
  assert.equal(notices().length, quiet)

  // Questions use the same pipeline, with the first question quoted.
  const beforeQuestion = notices().length
  const answered = await fixture.emit('user-questions/request', question('session-independent'), answerYes)
  assert.deepEqual(answered, { answers: [{ id: 'q1', selected: ['是'] }] })
  await settle()
  const questionNotices = notices().slice(beforeQuestion)
  assert.equal(questionNotices.length, 1)
  assert.match(bodyOf(questionNotices[0]), /Alpha Session/)
  assert.match(bodyOf(questionNotices[0]), /要现在部署吗/)
  assert.match(bodyOf(questionNotices[0]), /在等回答/)

  // Same question again is deduped.
  await fixture.emit('user-questions/request', question('session-independent'), answerYes)
  await settle()
  assert.equal(notices().length, beforeQuestion + 1)

  // A user-question-reply settles it; the next question notifies again.
  fixture.service.onSessionEvent(
    { header: { id: 'session-independent' } },
    { type: 'user/message', data: { source: { kind: 'user-question-reply' }, content: [{ type: 'text', text: '是' }] } },
  )
  await fixture.emit('user-questions/request', question('session-independent'), answerYes)
  await settle()
  assert.equal(notices().length, beforeQuestion + 2)

  // The turn boundary clears the elapsed clock; the notice omits the clause
  // instead of guessing.
  fixture.service.onSessionEvent({ header: { id: 'session-independent' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const beforeNoClock = notices().length
  await fixture.emit('user-questions/request', question('session-independent', { questions: [{ id: 'q2', question: '还要继续吗？' }] }), answerYes)
  await settle()
  const noClock = notices().slice(beforeNoClock)
  assert.equal(noClock.length, 1)
  assert.doesNotMatch(bodyOf(noClock[0]), /本轮已运行/)
} finally {
  fixture.cleanup()
  rmSync(independentCwd, { recursive: true, force: true })
}

// dsh-api-remotes registers first and holds the request for the browser. The
// plugin must still run (prepend) and must still leave the outcome to that
// downstream answerer (immediate next()). An appended listener would never run.
{
  const holderCwd = mkdtempSync(join(tmpdir(), 'ria-holder-'))
  const holder = await createFixture({
    v2Default: true,
    extraSessions: [
      { sessionId: 'session-holder', running: false, blank: false, updatedAt: 1, cwd: holderCwd, projections: { values: { title: 'Holder Session' } } },
    ],
    preListeners: {
      'approval/request': async () => 'rejected',
      'user-questions/request': async () => ({ answers: [{ id: 'q1', selected: ['否'] }] }),
    },
  })
  try {
    await holder.service.ensure()
    const holderChatbot = holder.service.v2.v2.chatbotSessionId
    const before = holder.prompts.length
    const rejected = await holder.emit('approval/request', approval('session-holder'), allowOnce)
    assert.equal(rejected, 'rejected')
    await settle()
    const sent = holder.prompts.slice(before).filter(item => String(item.sessionId) === String(holderChatbot))
    assert.equal(sent.length, 1)
    assert.match(bodyOf(sent[0]), /Holder Session/)
    assert.match(bodyOf(sent[0]), /bash/)
    // Cross-kind notices share the per-session flood guard; the holder fixture
    // only checks ordering and passthrough, so drop the guard.
    holder.service.v2.blockedNoticeMinIntervalMs = 0
    const answered = await holder.emit('user-questions/request', question('session-holder'), answerYes)
    assert.deepEqual(answered, { answers: [{ id: 'q1', selected: ['否'] }] })
    await settle()
    assert.equal(holder.prompts.filter(item => String(item.sessionId) === String(holderChatbot)).length, sent.length + 1)
  } finally {
    holder.cleanup()
    rmSync(holderCwd, { recursive: true, force: true })
  }
}

console.log('v2 blocked notices ok')
