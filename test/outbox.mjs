import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_MS,
  OUTBOX_RETRY_DELAYS_MS,
  Outbox,
} from '../lib/outbox.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// The queue itself: idempotent enqueue, durable reload, retry backoff, terminal
// failure with a readable reason, delivered retention and corrupt-file recovery.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ria-outbox-'))
  const file = join(dir, 'outbox.json')
  const log = []
  let clock = 1_000_000
  try {
    const box = new Outbox(file, { now: () => clock, log: (level, message) => log.push({ level, message }) })
    const first = box.enqueue({ kind: 'dispatch_note', dedupeKey: 'note_1', payload: { note: 'hello', ticketId: 'ticket_1' } })
    assert.equal(first.created, true)
    assert.equal(first.entry.status, 'pending')
    const duplicate = box.enqueue({ kind: 'dispatch_note', dedupeKey: 'note_1', payload: { note: 'hello', ticketId: 'ticket_1' } })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.entry.id, first.entry.id)
    assert.equal(box.all().length, 1)

    box.markFailed(first.entry.id, new Error('first failure'), clock)
    let entry = box.entry(first.entry.id)
    assert.equal(entry.status, 'pending')
    assert.equal(entry.attempts, 1)
    assert.equal(entry.lastError, 'first failure')
    assert.equal(entry.due, clock + OUTBOX_RETRY_DELAYS_MS[0])
    assert.equal(box.due(clock).length, 0)
    assert.equal(box.due(clock + OUTBOX_RETRY_DELAYS_MS[0]).length, 1)

    clock += OUTBOX_RETRY_DELAYS_MS[0]
    box.markFailed(first.entry.id, new Error('second failure'), clock)
    entry = box.entry(first.entry.id)
    assert.equal(entry.attempts, 2)
    assert.equal(entry.due, clock + OUTBOX_RETRY_DELAYS_MS[1])
    for (let attempt = 3; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      clock += 1
      box.markFailed(first.entry.id, new Error('failure ' + attempt), clock)
    }
    entry = box.entry(first.entry.id)
    assert.equal(entry.status, 'failed')
    assert.equal(entry.attempts, OUTBOX_MAX_ATTEMPTS)
    assert.equal(entry.lastError, 'failure ' + OUTBOX_MAX_ATTEMPTS)
    assert.equal(box.due(clock).length, 0)
    assert.equal(box.summary().failed, 1)
    assert.equal(box.summary().items[0].lastError, 'failure ' + OUTBOX_MAX_ATTEMPTS)

    const reloaded = new Outbox(file, { now: () => clock })
    assert.equal(reloaded.entry(first.entry.id).status, 'failed')
    assert.equal(reloaded.entry(first.entry.id).attempts, OUTBOX_MAX_ATTEMPTS)
    assert.equal(reloaded.summary({ ticketId: 'ticket_1' }).total, 1)

    const delivered = reloaded.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'note_2', payload: { note: 'sent', ticketId: 'ticket_2' } })
    reloaded.markDelivered(delivered.entry.id, clock)
    assert.equal(reloaded.entry(delivered.entry.id).status, 'delivered')
    assert.equal(reloaded.summary({ ticketId: 'ticket_2' }).delivered, 1)
    clock += OUTBOX_RETENTION_MS + 1
    reloaded.prune(clock)
    assert.equal(reloaded.entry(delivered.entry.id), undefined)
    assert.equal(reloaded.summary({ ticketId: 'ticket_2' }).total, 0)

    writeFileSync(file, '{ not json')
    const corruptLog = []
    const corrupt = new Outbox(file, { now: () => clock, log: (level, message) => corruptLog.push({ level, message }) })
    assert.deepEqual(corrupt.all(), [])
    assert.equal(corruptLog.some(item => item.level === 'error' && item.message.includes('corrupt')), true)
    assert.equal(existsSync(file + '.corrupt-' + clock), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Service integration: a card queued with no open turn waits; turn/start
// attaches it exactly once; a WeChat failure stays pending with a readable
// reason and succeeds after the retry; exhausted entries stay visible.
{
  const fixture = await createFixture()
  const service = fixture.service
  const sent = []
  const originalSend = service.wechat.sendDispatchNote
  service.wechat.sendDispatchNote = async (note, options) => {
    sent.push({ note, options })
    return true
  }
  try {
    const created = await fixture.call('ria_ticket', {
      goal: 'check the outbox',
      acceptance: 'the note is delivered once',
      executor: 'session-worker',
    })
    const ticketId = created.ticket.ticketId
    assert.equal(service.currentRiaTurn, undefined)
    assert.equal(service.store.dispatchNotes(fixture.riaAgent.id).length, 0)

    const noteId = service.appendDispatchNote(fixture.riaAgent, 'queued while idle', ticketId)
    assert.equal(typeof noteId, 'string')
    service.notifyDispatchNote('queued while idle', true, ticketId, noteId)
    await service.pumpOutbox('test-idle')
    assert.equal(service.store.dispatchNotes(fixture.riaAgent.id).length, 0)
    assert.equal(sent.length, 1)
    let status = await fixture.call('ria_status', { ticketId })
    assert.equal(status.outbox.pending, 1)
    assert.equal(status.outbox.failed, 0)
    assert.equal(status.outbox.delivered, 1)
    const queued = status.outbox.items.find(item => item.kind === 'dispatch_note')
    assert.equal(queued.ticketId, ticketId)
    assert.equal(queued.attempts, 0)
    assert.equal(queued.note, 'queued while idle')

    service.currentRiaTurn = 4
    await service.pumpOutbox('test-turn')
    let notes = service.store.dispatchNotes(fixture.riaAgent.id)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].turn, 4)
    assert.equal(notes[0].note, 'queued while idle')
    assert.equal(notes[0].ticketId, ticketId)
    await service.pumpOutbox('test-again')
    assert.equal(service.store.dispatchNotes(fixture.riaAgent.id).length, 1)
    status = await fixture.call('ria_status', { ticketId })
    assert.equal(status.outbox.pending, 0)
    assert.equal(status.outbox.delivered, 2)

    service.wechat.sendDispatchNote = async () => { throw new Error('wechat down') }
    const failingId = service.appendDispatchNote(fixture.riaAgent, 'retry me', ticketId)
    service.notifyDispatchNote('retry me', true, ticketId, failingId)
    await service.pumpOutbox('test-failure')
    notes = service.store.dispatchNotes(fixture.riaAgent.id)
    assert.equal(notes.length, 2)
    const failing = service.outbox.all().find(item => item.kind === 'wechat_dispatch_note' && item.payload.noteId === failingId)
    assert.equal(failing.status, 'pending')
    assert.equal(failing.attempts, 1)
    assert.equal(failing.lastError, 'wechat down')
    status = await fixture.call('ria_status', { ticketId })
    const failedItem = status.outbox.items.find(item => item.kind === 'wechat_dispatch_note')
    assert.equal(failedItem.lastError, 'wechat down')

    failing.due = 0
    service.wechat.sendDispatchNote = async (note, options) => {
      sent.push({ note, options })
      return true
    }
    await service.pumpOutbox('test-retry')
    assert.equal(service.outbox.entry(failing.id).status, 'delivered')
    assert.equal(sent.at(-1).note, 'retry me')

    const exhausted = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'exhausted', payload: { note: 'never sent', ticketId } })
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      service.outbox.markFailed(exhausted.entry.id, new Error('permanent ' + attempt), Date.now())
    }
    const after = await fixture.call('ria_status', { ticketId })
    assert.equal(after.outbox.failed, 1)
    const exhaustedItem = after.outbox.items.find(item => item.id === exhausted.entry.id)
    assert.equal(exhaustedItem.status, 'failed')
    assert.equal(exhaustedItem.attempts, OUTBOX_MAX_ATTEMPTS)
    assert.equal(exhaustedItem.lastError, 'permanent ' + OUTBOX_MAX_ATTEMPTS)
    const top = await fixture.call('ria_status', { scope: 'tickets' })
    assert.equal(top.outbox.failed, 1)
  } finally {
    service.wechat.sendDispatchNote = originalSend
    fixture.cleanup()
  }
}

// A trigger that lands while a pump is waiting on WeChat makes the same pump
// run another pass, so a turn opened mid-flight still gets its card at once.
{
  const fixture = await createFixture()
  const service = fixture.service
  let release
  const gate = new Promise(resolve => { release = resolve })
  const sent = []
  const originalSend = service.wechat.sendDispatchNote
  service.wechat.sendDispatchNote = async note => {
    sent.push(note)
    if (note === 'slow mirror') await gate
    return true
  }
  try {
    service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'slow', payload: { note: 'slow mirror' } })
    const first = service.pumpOutbox('test-slow')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent, ['slow mirror'])

    service.currentRiaTurn = 6
    const noteId = service.appendDispatchNote(fixture.riaAgent, 'queued mid-pump')
    assert.equal(typeof noteId, 'string')
    const second = service.pumpOutbox('test-trigger')
    assert.equal(second, first)
    release()
    await first

    const notes = service.store.dispatchNotes(fixture.riaAgent.id)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].note, 'queued mid-pump')
    assert.equal(notes[0].turn, 6)
  } finally {
    release()
    service.wechat.sendDispatchNote = originalSend
    fixture.cleanup()
  }
}

// The same logical dispatch (ticket + text + turn) reuses its queued entry
// instead of producing a second card.
{
  const fixture = await createFixture()
  const service = fixture.service
  try {
    service.currentRiaTurn = 8
    const first = service.appendDispatchNote(fixture.riaAgent, 'same confirmation', 'ticket_dup', 8)
    const second = service.appendDispatchNote(fixture.riaAgent, 'same confirmation', 'ticket_dup', 8)
    assert.equal(second, first)
    assert.equal(service.outbox.all().filter(entry => entry.kind === 'dispatch_note').length, 1)
    await service.pumpOutbox('test-dedupe')
    const notes = service.store.dispatchNotes(fixture.riaAgent.id)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].noteId, first)
  } finally {
    fixture.cleanup()
  }
}

// Startup pumps the queue even when there is no recovery work to do.
{
  const fixture = await createFixture()
  const service = fixture.service
  const sent = []
  const originalSend = service.wechat.sendDispatchNote
  service.wechat.sendDispatchNote = async note => {
    sent.push(note)
    return true
  }
  try {
    service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'startup', payload: { note: 'sent at startup' } })
    await service.startup()
    assert.deepEqual(sent, ['sent at startup'])
  } finally {
    service.wechat.sendDispatchNote = originalSend
    fixture.cleanup()
  }
}

// An automatic channel pause queues exactly one notice, keyed by pausedAt so a
// replay after restart cannot send it twice. Manual pauses and an offline
// WeChat never queue one.
{
  const fixture = await createFixture()
  const service = fixture.service
  const notices = []
  const originalSend = service.wechat.sendPauseNotice
  const originalOutbound = service.wechat.outbound
  service.wechat.outbound = {}
  service.wechat.sendPauseNotice = async (text, options) => {
    notices.push({ text, options })
    return true
  }
  try {
    const status = { paused: true, pausedBy: 'channel', pausedAt: '2026-11-12T06:00:00.000Z' }
    assert.equal(service.notifyWechatAutoPause(status), true)
    await service.pumpOutbox('test-auto-pause')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].options.durable, true)
    assert.match(notices[0].text, /Ria 已自动暂停微信/)
    assert.match(notices[0].text, /非微信通道消息/)
    const entries = service.outbox.all().filter(entry => entry.kind === 'wechat_pause_notice')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].status, 'delivered')

    assert.equal(service.notifyWechatAutoPause(status), true)
    await service.pumpOutbox('test-auto-pause-replay')
    assert.equal(notices.length, 1)
    assert.equal(service.outbox.all().filter(entry => entry.kind === 'wechat_pause_notice').length, 1)

    assert.equal(service.notifyWechatAutoPause({ ...status, pausedBy: 'manual' }), false)
    service.wechat.outbound = undefined
    assert.equal(service.notifyWechatAutoPause({ ...status, pausedAt: '2026-11-12T07:00:00.000Z' }), false)
    await service.pumpOutbox('test-auto-pause-offline')
    assert.equal(notices.length, 1)
    assert.equal(service.outbox.all().filter(entry => entry.kind === 'wechat_pause_notice').length, 1)
  } finally {
    service.wechat.sendPauseNotice = originalSend
    service.wechat.outbound = originalOutbound
    fixture.cleanup()
  }
}

// When only WeChat Claw is connected, the auto-pause notice is queued and
// delivered there; it names the paused legacy channel and its trigger.
{
  const fixture = await createFixture()
  const service = fixture.service
  const notices = []
  const originalOutbound = service.wechatClaw.outbound
  const originalPeer = service.wechatClaw.peer
  const originalSend = service.wechatClaw.sendPauseNotice
  service.wechat.outbound = undefined
  service.wechatClaw.outbound = {}
  service.wechatClaw.peer = { userId: 'user-1', contextToken: 'context-1' }
  service.wechatClaw.sendPauseNotice = async (text, options) => {
    notices.push({ text, options })
    return true
  }
  try {
    const status = { paused: true, pausedBy: 'channel', pausedAt: '2026-11-12T08:06:11.949Z', pauseReason: '微信 Claw 通道消息' }
    assert.equal(service.notifyWechatAutoPause(status), true)
    await service.pumpOutbox('test-auto-pause-claw')
    assert.equal(notices.length, 1)
    assert.match(notices[0].text, /Ria 已自动暂停微信「文件传输助手」推送/)
    assert.match(notices[0].text, /微信 Claw 通道消息/)
    const entry = service.outbox.all().find(item => item.kind === 'wechat_pause_notice')
    assert.equal(entry.status, 'delivered')
  } finally {
    service.wechatClaw.outbound = originalOutbound
    service.wechatClaw.peer = originalPeer
    service.wechatClaw.sendPauseNotice = originalSend
    fixture.cleanup()
  }
}

// Dispatch, approval and pause notes follow the most recently active
// WeChat-side channel. A deferred preferred channel falls through to the next
// one; when both defer the entry stays pending without spending an attempt.
{
  const fixture = await createFixture()
  const service = fixture.service
  const calls = []
  const originalLegacy = service.wechat.sendDispatchNote
  const originalClaw = service.wechatClaw.sendDispatchNote
  const originalLegacyApproval = service.wechat.sendApprovalNote
  const originalClawApproval = service.wechatClaw.sendApprovalNote
  const originalLegacyPause = service.wechat.sendPauseNotice
  const originalClawPause = service.wechatClaw.sendPauseNotice
  try {
    service.wechat.sendDispatchNote = async () => { calls.push('legacy'); return true }
    service.wechatClaw.sendDispatchNote = async () => { calls.push('claw'); return true }
    service.wechat.lastInboundAt = 100
    service.wechatClaw.lastInboundAt = 200
    service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'route-recent', payload: { note: 'recent' } })
    await service.pumpOutbox('route-recent')
    assert.deepEqual(calls.splice(0), ['claw'], 'the most recent channel should get the note')

    service.wechat.lastInboundAt = 300
    service.wechat.sendDispatchNote = async () => { calls.push('legacy:deferred'); return { deferred: true } }
    service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'route-fallback', payload: { note: 'fallback' } })
    await service.pumpOutbox('route-fallback')
    assert.deepEqual(calls.splice(0), ['legacy:deferred', 'claw'], 'a deferred channel should fall through')

    service.wechat.sendDispatchNote = async () => { calls.push('legacy:deferred'); return { deferred: true } }
    service.wechatClaw.sendDispatchNote = async () => { calls.push('claw:deferred'); return { deferred: true } }
    const both = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'route-both-deferred', payload: { note: 'later' } }).entry
    await service.pumpOutbox('route-both-deferred')
    assert.deepEqual(calls.splice(0), ['legacy:deferred', 'claw:deferred'])
    assert.equal(both.status, 'pending')
    assert.equal(both.attempts, 0)
    service.outbox.markDelivered(both.id)

    service.wechat.sendApprovalNote = async () => { calls.push('legacy:approval'); return { deferred: true } }
    service.wechatClaw.sendApprovalNote = async () => { calls.push('claw:approval'); return true }
    service.outbox.enqueue({ kind: 'wechat_approval_note', dedupeKey: 'route-approval', payload: { note: 'allow?' } })
    await service.pumpOutbox('route-approval')
    assert.deepEqual(calls.splice(0), ['legacy:approval', 'claw:approval'])

    service.wechat.sendPauseNotice = async () => { calls.push('legacy:pause'); return { deferred: true } }
    service.wechatClaw.sendPauseNotice = async () => { calls.push('claw:pause'); return true }
    service.outbox.enqueue({ kind: 'wechat_pause_notice', dedupeKey: 'route-pause', payload: { text: 'paused' } })
    await service.pumpOutbox('route-pause')
    assert.deepEqual(calls.splice(0), ['legacy:pause', 'claw:pause'])
  } finally {
    service.wechat.sendDispatchNote = originalLegacy
    service.wechatClaw.sendDispatchNote = originalClaw
    service.wechat.sendApprovalNote = originalLegacyApproval
    service.wechatClaw.sendApprovalNote = originalClawApproval
    service.wechat.sendPauseNotice = originalLegacyPause
    service.wechatClaw.sendPauseNotice = originalClawPause
    fixture.cleanup()
  }
}

// Real service pause/offline conditions defer without spending network retries.
{
  const fixture = await createFixture()
  const service = fixture.service
  try {
    const queued = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'long-pause', payload: { note: 'after resume' } }).entry
    service.wechat.state.data.paused = true
    service.wechat.outbound = { enqueue: async () => { throw new Error('must not send while paused') } }
    for (let tick = 0; tick < 10; tick += 1) await service.pumpOutbox('paused-tick')
    assert.equal(queued.status, 'pending')
    assert.equal(queued.attempts, 0)
    service.wechat.state.data.paused = false
    service.wechat.outbound = undefined
    await service.pumpOutbox('offline-tick')
    assert.equal(queued.attempts, 0)
    const sent = []
    service.wechat.outbound = { enqueue: async text => { sent.push(text) } }
    await service.pumpOutbox('connected-tick')
    assert.equal(queued.status, 'delivered')
    assert.equal(sent.length, 1)
    const failed = service.outbox.enqueue({ kind: 'wechat_dispatch_note', dedupeKey: 'real-failure', payload: { note: 'fail' } }).entry
    service.wechat.outbound = { enqueue: async () => { throw new Error('network down') } }
    await service.pumpOutbox('network-error')
    assert.equal(failed.attempts, 1)
    assert.equal(failed.lastError, 'network down')
  } finally {
    fixture.cleanup()
  }
}

console.log('outbox ok')
