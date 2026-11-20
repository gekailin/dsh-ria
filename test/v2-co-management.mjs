import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { CoManagement } from '../lib/v2/co-management.mjs'

const tempDir = () => mkdtempSync(join(tmpdir(), 'ria-co-management-'))
const dirs = [tempDir()]
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

try {
  // 1. Module: atomic file, limit, persistence, dedupe/merge, rate, retry, stale.
  {
    const dir = tempDir()
    let current = 1000
    const sent = []
    const notes = []
    const manager = new CoManagement({
      stateDir: dir,
      now: () => current,
      send: async (watch, body) => { sent.push({ watchId: watch.watchId, body }) },
      notify: message => notes.push(message),
      retryDelaysMs: [0, 0],
    })
    const added = manager.add({ sessionId: 'session-a', title: 'A', options: { rateLimit: { maxPerMin: 2, mergeWindowMs: 0, windowMs: 1000 } } })
    assert.equal(added.ok, true)
    const file = join(dir, 'co-management.json')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(manager.add({ sessionId: 'session-a', title: 'A' }).existing, true)
    for (let index = 0; index < 19; index += 1) manager.add({ sessionId: 'session-' + index, title: 's' + index })
    assert.equal(manager.add({ sessionId: 'session-over', title: 'over' }).code, 'watch_limit')

    manager.onAssistant('session-a', { seq: 1, text: 'one', event: { seq: 1 } })
    manager.onAssistant('session-a', { seq: 1, text: 'one', event: { seq: 1 } })
    manager.onAssistant('session-a', { seq: 2, text: 'two', event: { seq: 2 } })
    const first = await manager.flush('session-a')
    assert.equal(first.ok, true)
    assert.equal(sent.length, 1)
    assert.match(sent[0].body, /one\ntwo|two\none/)
    assert.equal(manager.watch('session-a').cursors.lastRelayedSeq, 2)
    manager.onAssistant('session-a', { seq: 2, text: 'two', event: { seq: 2 } })
    assert.equal(manager.onAssistant('session-a', { seq: 2, text: 'two' }).code, 'cursor')

    // Rate limit: the third batch is suppressed, then the next allowed flush
    // carries the omitted count.
    manager.onAssistant('session-a', { seq: 3, text: 'three' })
    assert.equal((await manager.flush('session-a')).ok, true)
    manager.onAssistant('session-a', { seq: 4, text: 'four' })
    assert.equal((await manager.flush('session-a')).code, 'rate_limited')
    current += 1001
    manager.onAssistant('session-a', { seq: 5, text: 'five' })
    await manager.flush('session-a')
    assert.match(sent.at(-1).body, /另有 1 条输出已省略/)

    // Reload keeps watches and cursors; restart must not replay old seq.
    const reloaded = new CoManagement({ stateDir: dir, now: () => current, send: async () => {}, notify: () => {} })
    const loaded = reloaded.watch('session-a')
    assert.ok(loaded)
    assert.equal(loaded.cursors.lastRelayedSeq, 5)
    assert.equal(reloaded.onAssistant('session-a', { seq: 5, text: 'old' }).code, 'cursor')
    assert.equal(reloaded.onAssistant('session-a', { seq: 6, text: 'new' }).ok, true)
    assert.equal(reloaded.watch('session-a').status, 'active')
    reloaded.close()

    // Failure: three attempts, then one visible failure notice; no outbox here.
    const failNotes = []
    let attempts = 0
    const failing = new CoManagement({
      stateDir: tempDir(),
      now: () => current,
      send: async () => { attempts += 1; throw new Error('channel down') },
      notify: message => failNotes.push(message),
      retryDelaysMs: [0, 0],
    })
    failing.add({ sessionId: 'session-fail', title: 'Fail' })
    failing.onAssistant('session-fail', { seq: 1, text: 'oops' })
    const failed = await failing.flush('session-fail')
    assert.equal(failed.ok, false)
    assert.equal(attempts, 3)
    assert.ok(failNotes.some(message => message.includes('协管转述发送失败') && message.includes('已重试 2 次')))
    failing.close()

    // Stale notification is once.
    const staleNotes = []
    const stale = new CoManagement({ stateDir: tempDir(), now: () => current, send: async () => {}, notify: message => staleNotes.push(message) })
    stale.add({ sessionId: 'session-stale', title: 'Stale' })
    stale.markStale('session-stale', 'archived')
    stale.markStale('session-stale', 'archived')
    assert.equal(staleNotes.filter(message => message.includes('已归档')).length, 1)
    stale.close()
    manager.close()
  }

  // 2. Controller: tool/command surface, relay, user observation, questions,
  // approval risk, stale, routing.
  {
    const cwd = tempDir()
    const fixture = await createFixture({
      v2Default: true,
      extraSessions: [
        { sessionId: 'session-watch', running: false, blank: false, updatedAt: 10, cwd, projections: { values: { title: 'Watched Session' } } },
        { sessionId: 'session-other', running: false, blank: false, updatedAt: 9, cwd, projections: { values: { title: 'Other Session' } } },
      ],
    })
    try {
      const chatbot = fixture.service.v2.v2.chatSessionId
      const added = await fixture.callAs(chatbot, 'chatbot_watch', { action: 'add', sessionId: 'session-watch' })
      assert.equal(added.ok, true, JSON.stringify(added))
      assert.equal(added.watch.sessionId, 'session-watch')
      const listed = await fixture.callAs(chatbot, 'chatbot_watch', { action: 'list' })
      assert.equal(listed.watches.length, 1)
      const status = await fixture.callAs(chatbot, 'chatbot_watch', { action: 'status', sessionId: 'session-watch' })
      assert.equal(status.watch.titleSnapshot, 'Watched Session')
      await assert.rejects(() => fixture.callAs('session-other', 'chatbot_watch', { action: 'list' }), /tool not installed|forbidden/)

      // Commands.
      const command = await fixture.service.v2.handleWatchCommand('/协管列表', chatbot)
      assert.equal(command.handled, true)
      assert.match(command.reply, /Watched Session/)
      const statusCommand = await fixture.service.v2.handleWatchCommand('/协管状态 session-watch', chatbot)
      assert.equal(statusCommand.ok, true)
      const removeCommand = await fixture.service.v2.handleWatchCommand('/取消协管 session-watch', chatbot)
      assert.equal(removeCommand.ok, true)
      assert.equal(fixture.service.v2.coManagement.watches().length, 0)
      const addCommand = await fixture.service.v2.handleWatchCommand('/协管 Watched', chatbot)
      assert.equal(addCommand.ok, true, JSON.stringify(addCommand))

      const watch = () => fixture.service.v2.coManagement.watch('session-watch')
      const emitAssistant = (seq, text) => fixture.service.onSessionEvent(
        { header: { id: 'session-watch' } },
        { type: 'assistant/message', seq, time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } },
      )
      emitAssistant(10, 'first reply')
      await fixture.service.v2.coManagement.flush('session-watch')
      const notices = () => fixture.prompts.filter(item => String(item.sessionId) === String(chatbot)).map(item => String(item.content[0].text))
      assert.ok(notices().some(text => text.includes('【协管·Watched Session】') && text.includes('first reply')))
      emitAssistant(10, 'duplicate reply')
      await fixture.service.v2.coManagement.flush('session-watch')
      assert.equal(notices().filter(text => text.includes('first reply')).length, 1)
      emitAssistant(11, 'second')
      emitAssistant(12, 'third')
      await fixture.service.v2.coManagement.flush('session-watch')
      assert.ok(notices().some(text => text.includes('second') && text.includes('third')))

      // Direct user message is observed; host-injected messages are not.
      fixture.service.onSessionEvent(
        { header: { id: 'session-watch' } },
        { type: 'user/message', seq: 20, time: Date.now(), data: { content: [{ type: 'text', text: 'please also do X' }], source: { kind: 'user', rpcId: 'user-direct-1' } } },
      )
      assert.equal(watch().cursors.lastUserSeq, 20)
      assert.ok(notices().some(text => text.includes('用户直接对会话说') && text.includes('please also do X')))
      fixture.service.onSessionEvent(
        { header: { id: 'session-watch' } },
        { type: 'user/message', seq: 21, time: Date.now(), data: { content: [{ type: 'text', text: 'injected by ria' }], source: { kind: 'user', rpcId: 'host_injected' } } },
      )
      assert.equal(watch().cursors.lastUserSeq, 20)

      // Questions are relayed but never answered by watch.
      let nextCalled = false
      const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
      const got = await fixture.emit(
        'user-questions/request',
        { agent: { id: 'session-watch' }, questions: [{ id: 'q1', question: 'which one?' }], signal: new AbortController().signal },
        async () => { nextCalled = true; return answer },
      )
      assert.deepEqual(got, answer)
      assert.equal(nextCalled, true)
      assert.ok(notices().some(text => text.includes('在等你回答') && text.includes('which one?')))
      assert.ok(fixture.service.v2.coManagement.pending().some(item => item.sessionId === 'session-watch' && item.question === 'which one?'))

      // Approval: low auto-allows, high asks and delegates to next().
      await fixture.emit('tools/pre-execute', { agent: { id: 'session-watch' }, name: 'bash', callId: 'watch-low', arguments: { command: 'git status' } }, async () => ({ kind: 'enter' }))
      const low = await fixture.emit(
        'approval/request',
        { agent: { id: 'session-watch' }, toolName: 'bash', callId: 'watch-low', reason: 'read only', signal: new AbortController().signal },
        async () => 'rejected',
      )
      assert.equal(low, 'allowed-once')
      assert.ok(notices().some(text => text.includes('已自动放行低风险提权')))

      await fixture.emit('tools/pre-execute', { agent: { id: 'session-watch' }, name: 'bash', callId: 'watch-high', arguments: { command: 'echo probe > /home/gkl/Desktop/ria-watch-probe.txt' } }, async () => ({ kind: 'enter' }))
      const high = await fixture.emit(
        'approval/request',
        { agent: { id: 'session-watch' }, toolName: 'bash', callId: 'watch-high', reason: 'write outside', signal: new AbortController().signal },
        async () => 'rejected',
      )
      assert.equal(high, 'rejected')
      assert.ok(notices().some(text => text.includes('需要你决定的提权') && text.includes('level=high')))

      // Stale notification only once.
      const beforeStale = notices().length
      fixture.service.v2.coManagement.markStale('session-watch', 'archived')
      fixture.service.v2.coManagement.markStale('session-watch', 'archived')
      await settle()
      assert.equal(notices().filter(text => text.includes('已归档')).length, 1)

      // Work is dispatched through tickets now (see test/v2-co-managed.mjs):
      // the old direct chat-to-session routing channel is gone on purpose.

      // Direct mode has no coupling to watch state/dedupe.
      assert.equal('direct' in fixture.service.v2.coManagement, false)
      fixture.service.v2.direct = { sessionId: 'session-watch' }
      assert.equal(fixture.service.v2.coManagement.watch('session-watch').status, 'stale')
    } finally {
      fixture.cleanup()
    }
  }

  console.log('v2 co-management ok')
} finally {
  for (const dir of dirs.splice(0).reverse()) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}
