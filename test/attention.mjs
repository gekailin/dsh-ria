import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { assertTicketInvariants, normalizeAttention, normalizeTicket } from '../lib/tickets.mjs'

function userMessage(id, text, rpcId = 'rpc-' + id) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId },
  }
}

function capture(fixture, id, text, turn) {
  return fixture.service.store.captureIntake({
    sessionId: fixture.riaAgent.id,
    turn,
    message: userMessage(id, text),
  })
}

function blockedTicket(store, overrides = {}) {
  return store.addTicket({
    goal: 'choose a deployment',
    acceptance: 'one option is picked',
    executor: 'session-worker',
    status: 'blocked',
    blockedReason: 'waiting for the user to choose',
    waitingOn: 'user',
    ...overrides,
  })
}

// normalizeAttention keeps the documented shape, defaults, and limits.
{
  const at = 1700000000000
  assert.equal(normalizeAttention(null, at), null)
  assert.equal(normalizeAttention({}, at), null)
  assert.equal(normalizeAttention({ question: '   ' }, at), null)
  const attention = normalizeAttention({ kind: 'nope', question: '  which one?  ', options: ['a', '', ' b '], askedBy: ' ria ', askedAt: 5, ref: ' turn-3 ' }, at)
  assert.deepEqual(attention, {
    kind: 'question',
    question: 'which one?',
    askedAt: 5,
    askedBy: 'ria',
    options: ['a', 'b'],
    ref: 'turn-3',
  })
  const long = normalizeAttention({ question: 'x'.repeat(900), options: Array.from({ length: 20 }, (_, i) => String(i)) }, at)
  assert.equal([...long.question].length, 500)
  assert.equal(long.options.length, 10)
  assert.equal(long.askedAt, at)
  assert.equal(long.askedBy, 'ria')
}

// A blocked ticket stores attention, persists it, and status lists the exact
// question. Moving it off blocked clears attention; a legacy ticket still shows
// up with legacy=true and its blockedReason as the question.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = blockedTicket(store, {
      attention: { kind: 'decision', question: '用 A 方案还是 B 方案？', options: ['A', 'B'], askedBy: 'ria' },
    })
    assert.equal(ticket.status, 'blocked')
    assert.equal(ticket.attention.kind, 'decision')
    assert.equal(ticket.attention.question, '用 A 方案还是 B 方案？')
    assert.deepEqual(ticket.attention.options, ['A', 'B'])
    assert.equal(ticket.blockedReason, 'waiting for the user to choose')

    const saved = JSON.parse(readFileSync(join(fixture.stateDir, 'ria.json'), 'utf8'))
    assert.equal(saved.tickets.find(item => item.ticketId === ticket.ticketId).attention.question, '用 A 方案还是 B 方案？')

    const status = await fixture.call('ria_status', { scope: 'tickets' })
    assert.equal(status.attentionOverview.waitingOnUser, 1)
    assert.deepEqual(status.attentionOverview.items, [{
      ticketId: ticket.ticketId,
      goal: 'choose a deployment',
      question: '用 A 方案还是 B 方案？',
      kind: 'decision',
      legacy: false,
      options: ['A', 'B'],
      askedAt: ticket.attention.askedAt,
      askedBy: 'ria',
    }])

    const missing = await fixture.call('ria_status', { ticketId: 'ticket-missing' })
    assert.equal(missing.found, false)
    assert.equal(missing.attentionOverview.waitingOnUser, 1)

    const legacy = blockedTicket(store, { goal: 'legacy question', blockedReason: '旧票只写了原因' })
    assert.equal(legacy.attention, null)
    const overview = (await fixture.call('ria_status', { scope: 'tickets' })).attentionOverview
    assert.equal(overview.waitingOnUser, 2)
    const legacyItem = overview.items.find(item => item.ticketId === legacy.ticketId)
    assert.equal(legacyItem.legacy, true)
    assert.equal(legacyItem.question, '旧票只写了原因')

    const moved = store.transitionTicket(ticket.ticketId, 'open', { reason: 'user decided' })
    assert.equal(moved.ok, true)
    assert.equal(moved.ticket.attention, null)
    assert.equal(moved.ticket.blockedReason, '')
  } finally {
    fixture.cleanup()
  }
}

// updateTicket can replace the question while the ticket stays blocked.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const ticket = blockedTicket(store, { attention: { question: 'first?' } })
    const updated = store.updateTicket(ticket.ticketId, { attention: { kind: 'approval', question: 'second?', options: ['yes'] } })
    assert.equal(updated.attention.kind, 'approval')
    assert.equal(updated.attention.question, 'second?')
    assert.deepEqual(updated.attention.options, ['yes'])
    assert.equal(updated.status, 'blocked')
  } finally {
    fixture.cleanup()
  }
}

// ria_ticket create accepts attention + waitingOn; attention without a
// blockedReason falls back to the question.
{
  const fixture = await createFixture()
  try {
    const created = await fixture.call('ria_ticket', {
      goal: 'pick a database',
      acceptance: 'one is chosen',
      executor: 'session-worker',
      status: 'blocked',
      waitingOn: 'user',
      attention: { kind: 'question', question: 'Postgres 还是 SQLite？', options: ['Postgres', 'SQLite'] },
    })
    assert.equal(created.ticket.status, 'blocked')
    assert.equal(created.ticket.blockedReason, 'Postgres 还是 SQLite？')
    assert.equal(created.ticket.attention.question, 'Postgres 还是 SQLite？')
    const status = await fixture.call('ria_status', { ticketId: created.ticket.ticketId })
    assert.equal(status.attentionOverview.items[0].question, 'Postgres 还是 SQLite？')
    const updated = await fixture.call('ria_ticket', {
      ticketId: created.ticket.ticketId,
      status: 'blocked',
      attention: { kind: 'decision', question: '换成 MySQL？' },
    })
    assert.equal(updated.ticket.attention.question, '换成 MySQL？')
  } finally {
    fixture.cleanup()
  }
}

// ria_resolve kind=blocked stores attention for a user question; approval and
// environment waits do not carry attention.
{
  const fixture = await createFixture()
  try {
    const intake = capture(fixture, 'm-blocked', '这个先等你确认', 9).ticket
    const blocked = await fixture.call('ria_resolve', {
      ticketId: intake.ticketId,
      kind: 'blocked',
      waitingOn: 'user',
      attention: { kind: 'decision', question: '要现在部署还是明天？', options: ['现在', '明天'] },
    })
    assert.equal(blocked.ok, true)
    assert.equal(blocked.ticket.status, 'blocked')
    assert.equal(blocked.ticket.blockedReason, '要现在部署还是明天？')
    assert.equal(blocked.ticket.attention.question, '要现在部署还是明天？')
    assert.deepEqual(blocked.ticket.attention.options, ['现在', '明天'])

    const approvalIntake = capture(fixture, 'm-approval', '这个等审批', 10).ticket
    const approval = await fixture.call('ria_resolve', {
      ticketId: approvalIntake.ticketId,
      kind: 'blocked',
      waitingOn: 'approval',
      blockedReason: 'waiting for a worker approval',
      attention: { question: 'should not stick' },
    })
    assert.equal(approval.ok, true)
    assert.equal(approval.ticket.attention, null)

    const overview = await fixture.service.attentionOverview()
    assert.equal(overview.waitingOnUser, 1)
    assert.equal(overview.items[0].ticketId, blocked.ticket.ticketId)
  } finally {
    fixture.cleanup()
  }
}

// Whitespace-only legacy reasons fall back to the structured question.
{
  const fixture = await createFixture()
  try {
    const ticket = blockedTicket(fixture.service.store, { blockedReason: ' \t\n ', attention: { question: 'choose?' } })
    assert.equal(ticket.blockedReason, 'choose?')
    ticket.blockedReason = '   '
    fixture.service.store.save()
    fixture.service.store.load()
    assert.equal(fixture.service.store.ticket(ticket.ticketId).blockedReason, 'choose?')
    const loaded = normalizeTicket(JSON.parse(JSON.stringify({ ...ticket, blockedReason: '   ' })))
    assert.equal(loaded.blockedReason, 'choose?')
    assertTicketInvariants(loaded)
    const legacy = normalizeTicket({ taskId: 'old-blocked', status: 'blocked', blockedReason: '   ' })
    assert.equal(legacy.blockedReason, 'legacy blocked ticket')
    assertTicketInvariants(legacy)
    const explicit = normalizeTicket({ ...ticket, blockedReason: '  explicit reason  ' })
    assert.equal(explicit.blockedReason, '  explicit reason  ')
  } finally {
    fixture.cleanup()
  }
}

console.log('attention ok')
