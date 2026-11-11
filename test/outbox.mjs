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

console.log('outbox ok')
