import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { applyChecklistUpdate, checklistProgress, normalizeChecklist, parseChecklistInput } from '../lib/tickets.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const repo = new URL('..', import.meta.url)

function rejectsWith(promise, code) {
  return promise.then(
    () => { throw new Error('expected rejection with ' + code) },
    error => {
      assert.equal(error && error.code, code, 'unexpected error: ' + String(error && error.message ? error.message : error))
      return error
    },
  )
}

// Pure helpers: normalization is forgiving, writes are strict.
assert.deepEqual(normalizeChecklist([' a ', 'a', '', { text: 'b', done: true }, { text: 'c', done: false }]), [
  { text: 'a', done: false },
  { text: 'b', done: true },
  { text: 'c', done: false },
])
assert.deepEqual(checklistProgress([{ text: 'a', done: true }, { text: 'b', done: false }]), { done: 1, total: 2, text: '1/2' })
assert.deepEqual(checklistProgress([]), { done: 0, total: 0, text: '' })
assert.throws(() => parseChecklistInput([{ text: 'a', done: 'yes' }]), error => error.code === 'checklist_invalid')
assert.throws(() => parseChecklistInput(['a', 'a']), error => error.code === 'checklist_invalid')
assert.throws(() => applyChecklistUpdate([], ['a'], { replaceAll: true, drop: [0] }), error => error.code === 'checklist_invalid')

// v3 files load unchanged, gain an empty checklist, and keep an exact backup.
const migrationDir = mkdtempSync(join(tmpdir(), 'dsh-ria-checklist-v3-'))
try {
  const v3 = JSON.stringify({
    schemaVersion: 3,
    version: 3,
    tickets: [{ ticketId: 'ticket_old', goal: 'legacy work', executor: 'self', status: 'open', createdAt: 1, updatedAt: 1 }],
  }, null, 2)
  writeFileSync(join(migrationDir, 'ria.json'), v3)
  const store = new RiaStore(migrationDir)
  assert.equal(store.data.schemaVersion, 5)
  assert.equal(store.data.tickets.length, 1)
  assert.deepEqual(store.data.tickets[0].checklist, [])
  assert.equal(readFileSync(join(migrationDir, 'ria.json.v3.bak'), 'utf8'), v3)
  assert.equal(JSON.parse(readFileSync(join(migrationDir, 'ria.json'), 'utf8')).schemaVersion, 5)
} finally {
  rmSync(migrationDir, { recursive: true, force: true })
}

const fixture = await createFixture()
try {
  const created = await fixture.call('ria_ticket', {
    goal: 'ship the checklist',
    executor: 'self',
    checklist: ['write the parser', { text: 'wire the tool', done: true }],
  })
  const ticketId = created.ticket.ticketId
  assert.equal(created.ticket.progress, '1/2')
  assert.deepEqual(created.ticket.checklist, [
    { text: 'write the parser', done: false },
    { text: 'wire the tool', done: true },
  ])

  const one = await fixture.call('ria_status', { ticketId })
  assert.equal(one.ticket.progress, '1/2')
  const all = await fixture.call('ria_status', { scope: 'tickets' })
  assert.equal(all.tickets.find(item => item.ticketId === ticketId).progress, '1/2')
  const board = await fixture.service.boardData()
  const card = board.tickets.find(item => item.ticketId === ticketId)
  assert.equal(card.progress, '1/2')
  assert.equal(card.checklist.length, 2)

  const ticked = await fixture.call('ria_ticket', { ticketId, check: { index: 0, done: true } })
  assert.equal(ticked.ticket.progress, '2/2')

  await rejectsWith(fixture.call('ria_ticket', { ticketId, check: { index: 9, done: true } }), 'checklist_index')
  await rejectsWith(fixture.call('ria_ticket', { ticketId, check: { index: 0, done: 'yes' } }), 'checklist_invalid')
  await rejectsWith(fixture.call('ria_ticket', { ticketId, check: { index: 0, done: false }, goal: 'other' }), 'checklist_invalid')
  await rejectsWith(fixture.call('ria_ticket', { ticketId, checklist: ['x', 'x'] }), 'checklist_invalid')
  assert.equal((await fixture.call('ria_status', { ticketId })).ticket.progress, '2/2')

  // Append: old items stay, a bare old text keeps its tick, explicit done can clear it.
  const appended = await fixture.call('ria_ticket', { ticketId, checklist: ['publish the note'] })
  assert.deepEqual(appended.ticket.checklist.map(item => item.text), ['write the parser', 'wire the tool', 'publish the note'])
  assert.equal(appended.ticket.progress, '2/3')
  const kept = await fixture.call('ria_ticket', { ticketId, checklist: ['write the parser'] })
  assert.equal(kept.ticket.checklist[0].done, true)
  const cleared = await fixture.call('ria_ticket', { ticketId, checklist: [{ text: 'write the parser', done: false }] })
  assert.equal(cleared.ticket.checklist[0].done, false)
  assert.equal(cleared.ticket.progress, '1/3')

  // replaceAll keeps ticks for unchanged text.
  await fixture.call('ria_ticket', { ticketId, check: { index: 2, done: true } })
  const replaced = await fixture.call('ria_ticket', {
    ticketId,
    replaceAll: true,
    checklist: ['publish the note', 'write the parser', 'announce it'],
  })
  assert.deepEqual(replaced.ticket.checklist, [
    { text: 'publish the note', done: true },
    { text: 'write the parser', done: false },
    { text: 'announce it', done: false },
  ])
  assert.equal(replaced.ticket.progress, '1/3')

  // drop removes by old index before appending.
  const dropped = await fixture.call('ria_ticket', {
    ticketId,
    drop: [0],
    checklist: ['write the parser'],
  })
  assert.deepEqual(dropped.ticket.checklist, [
    { text: 'write the parser', done: false },
    { text: 'announce it', done: false },
  ])
  await rejectsWith(fixture.call('ria_ticket', { ticketId, drop: [7] }), 'checklist_index')
  await rejectsWith(fixture.call('ria_ticket', { ticketId, replaceAll: true, drop: [0], checklist: [] }), 'checklist_invalid')

  // Terminal tickets are final.
  await fixture.call('ria_ticket', { ticketId, status: 'working' })
  await fixture.call('ria_ticket', { ticketId, status: 'done' })
  await rejectsWith(fixture.call('ria_ticket', { ticketId, check: { index: 0, done: true } }), 'checklist_invalid')

  // Marking done with open checklist items warns and records them in resolution.
  const unfinished = await fixture.call('ria_ticket', {
    goal: 'finish with open steps',
    executor: 'self',
    checklist: ['done step', { text: 'done too', done: true }, 'still open'],
  })
  await fixture.call('ria_ticket', { ticketId: unfinished.ticket.ticketId, status: 'working' })
  const finished = await fixture.call('ria_ticket', { ticketId: unfinished.ticket.ticketId, status: 'done' })
  assert.match(finished.warning, /清单还有 2 项未勾选/)
  const finishedRaw = fixture.service.store.ticket(unfinished.ticket.ticketId)
  assert.deepEqual(finishedRaw.resolution.checklistPending, {
    total: 3,
    done: 1,
    pending: ['done step', 'still open'],
  })

  // A checklist sent together with status=done is part of the final state.
  const late = await fixture.call('ria_ticket', {
    goal: 'add a step while finishing',
    executor: 'self',
    checklist: ['first step'],
  })
  await fixture.call('ria_ticket', { ticketId: late.ticket.ticketId, status: 'working' })
  const lateDone = await fixture.call('ria_ticket', {
    ticketId: late.ticket.ticketId,
    status: 'done',
    checklist: ['second open step'],
  })
  assert.match(lateDone.warning, /清单还有 2 项未勾选/)
  assert.deepEqual(fixture.service.store.ticket(late.ticket.ticketId).resolution.checklistPending.pending, ['first step', 'second open step'])

  // A merge keeps the target's checklist and never inherits the source's.
  const mergeSource = await fixture.call('ria_ticket', {
    goal: 'merge source',
    executor: 'self',
    checklist: ['source step'],
  })
  const mergeTarget = await fixture.call('ria_ticket', {
    goal: 'merge target',
    executor: 'self',
    checklist: [{ text: 'target step', done: true }],
  })
  const merged = await fixture.call('ria_ticket', {
    action: 'merge',
    sourceTicketId: mergeSource.ticket.ticketId,
    targetTicketId: mergeTarget.ticket.ticketId,
  })
  assert.deepEqual(merged.target.checklist, [{ text: 'target step', done: true }])
  assert.deepEqual(fixture.service.store.ticket(mergeTarget.ticket.ticketId).checklist, [{ text: 'target step', done: true }])

  // Archive summaries carry the total, done count, and at most five pending items.
  const wide = await fixture.call('ria_ticket', {
    goal: 'wide checklist',
    executor: 'self',
    checklist: ['one', 'two', { text: 'three', done: true }, 'four', 'five', 'six', 'seven', 'eight'],
  })
  const raw = fixture.service.store.ticket(wide.ticket.ticketId)
  const record = fixture.service.store.archiveRecord(raw)
  assert.equal(record.checklist.total, 8)
  assert.equal(record.checklist.done, 1)
  assert.deepEqual(record.checklist.pending, ['one', 'two', 'four', 'five', 'six'])

  const prompt = readFileSync(new URL('lib/index.js', repo), 'utf8')
  assert.match(prompt, /For multi-step or long-running work, create the ticket with a short checklist/)
  assert.match(prompt, /When \[Worker idle\] wakes you, read the checklist first/)
  const client = readFileSync(new URL('lib/client.js', repo), 'utf8')
  assert.match(client, /"清单 "/)
} finally {
  fixture.cleanup()
}

console.log('checklist ok')
