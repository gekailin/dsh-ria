import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'

const HOUR = 60 * 60 * 1000

function open(store, goal) {
  return store.addTicket({ goal, acceptance: 'ok', executor: 'session-worker' })
}

function close(store, ticket, at, goal) {
  const working = store.transitionTicket(ticket.ticketId, 'working', {
    attempt: { lastRequestId: 'req_' + ticket.ticketId, startedAt: 1, legacy: false },
  })
  assert.equal(working.ok, true, working.message)
  const done = store.transitionTicket(ticket.ticketId, 'done', {
    resolution: { summary: goal || 'done' },
    closedAt: at,
  })
  assert.equal(done.ok, true, done.message)
  return done.ticket
}

// Retention window: every non-terminal ticket stays, the newest 50 terminal
// tickets stay, and terminal tickets closed in the last 24h stay even when
// they are outside the newest 50.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const at = Date.now()
    const active = open(store, 'still running')
    const recent = [close(store, open(store, 'recent one'), at - HOUR, 'recent one'), close(store, open(store, 'recent two'), at - 2 * HOUR, 'recent two')]
    const old = []
    for (let index = 0; index < 55; index += 1) {
      old.push(close(store, open(store, 'old ' + index), at - 48 * HOUR - index * 1000, 'old ' + index))
    }
    const result = store.archiveClosedTickets()
    assert.equal(result.archived, 7)
    assert.equal(store.ticket(active.ticketId).status, 'open')
    for (const ticket of recent) assert.equal(store.ticket(ticket.ticketId).status, 'done')
    assert.equal(store.tickets().filter(ticket => ticket.status === 'done').length, 50)
    assert.equal(store.tickets().length, 51)
    const archived = old.filter(ticket => !store.ticket(ticket.ticketId))
    assert.equal(archived.length, 7)
    assert.equal(existsSync(join(fixture.stateDir, 'tasks.log.jsonl')), true)
    const lines = readFileSync(join(fixture.stateDir, 'tasks.log.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 7)
    const first = JSON.parse(lines[0])
    assert.equal(first.schema, 1)
    assert.equal(first.ticket.ticketId, first.ticketId)
    assert.equal(typeof first.attempts.count, 'number')
    assert.equal(typeof first.feedback.count, 'number')
    const month = new Date(archived[0].closedAt)
    const monthFile = 'tasks-' + month.getUTCFullYear() + '-' + String(month.getUTCMonth() + 1).padStart(2, '0') + '.jsonl'
    assert.equal(existsSync(join(fixture.stateDir, monthFile)), true)

    const target = archived[0]
    const exact = await fixture.call('ria_status', { ticketId: target.ticketId })
    assert.equal(exact.scope, 'ticket')
    assert.equal(exact.archived, true)
    assert.equal(exact.ticket.ticketId, target.ticketId)
    const history = await fixture.call('ria_status', { scope: 'history', limit: 5 })
    assert.equal(history.scope, 'history')
    assert.equal(history.archived, true)
    assert.equal(history.tickets.length, 5)
    assert.equal(history.tickets.every(ticket => ticket.archived === true), true)
    assert.equal(history.tickets.some(ticket => ticket.ticketId === target.ticketId), true)
    const hot = await fixture.call('ria_status', { scope: 'tasks' })
    assert.equal(hot.tasks.some(ticket => ticket.ticketId === target.ticketId), false)

    const reopened = await fixture.call('ria_task', { taskId: target.ticketId, status: 'open' })
    assert.equal(reopened.task.status, 'open')
    assert.equal(reopened.task.ticketId, target.ticketId)
    assert.equal(store.ticket(target.ticketId).status, 'open')
    assert.equal(store.ticket(target.ticketId).reopenCount, 1)
    const after = await fixture.call('ria_status', { ticketId: target.ticketId })
    assert.equal(after.archived, false)
  } finally {
    fixture.cleanup()
  }
}

// Monthly retention keeps the newest 12 files and never touches ria.json.
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const names = []
    for (let month = 1; month <= 13; month += 1) {
      const name = 'tasks-2024-' + String(month).padStart(2, '0') + '.jsonl'
      names.push(name)
      writeFileSync(join(fixture.stateDir, name), '')
    }
    store.pruneTicketLogs()
    assert.equal(existsSync(join(fixture.stateDir, names[0])), false)
    assert.equal(existsSync(join(fixture.stateDir, names[1])), true)
    assert.equal(existsSync(join(fixture.stateDir, names[12])), true)
  } finally {
    fixture.cleanup()
  }
}

// A second prune is a no-op, and an archived record survives a fresh store
// load (the ticket is gone from ria.json but still exact-queryable).
{
  const fixture = await createFixture()
  try {
    const store = fixture.service.store
    const at = Date.now() - 72 * HOUR
    const tickets = []
    for (let index = 0; index < 52; index += 1) tickets.push(close(store, open(store, 't' + index), at - index * 1000))
    store.archiveClosedTickets()
    const archivedId = tickets.at(-1).ticketId
    assert.equal(store.ticket(archivedId), undefined)
    assert.equal(store.archiveClosedTickets().archived, 0)
    const Store = fixture.service.store.constructor
    const reloaded = new Store(fixture.stateDir)
    assert.equal(reloaded.ticket(archivedId), undefined)
    assert.equal(reloaded.findArchivedTicket(archivedId).ticketId, archivedId)
    assert.equal(reloaded.historyTickets(10).length, 2)
  } finally {
    fixture.cleanup()
  }
}

console.log('archive ok')
