import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { readReflectionState } from '../lib/reflection.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-reflection-api-'))
try {
  const tickets = []
  const meta = {}
  let creates = 0
  let nextStatus = { ok: true }
  const service = Object.create(RiaService.prototype)
  service.stateDir = dir
  service.reflections = new Map()
  const events = []
  service.routerEvents = { append: event => events.push(event) }
  service.log = () => {}
  service.store = { reflectionSettings: () => ({ enabled: false }) }
  service.schedule = null
  service.tickets = {
    tickets: () => tickets,
    ticket: id => tickets.find(ticket => ticket.ticketId === id),
  }
  // Mirror the real shape: RiaService.state is the Controller, and the
  // metadata store is controller.state. A flat stub previously hid the 503.
  service.controller = {
    requestTicket: async () => {
      creates += 1
      if (!nextStatus.ok) return nextStatus
      const ticket = { ticketId: 'ticket_reflect_' + creates, status: 'open' }
      tickets.push(ticket)
      meta[ticket.ticketId] = { ticketId: ticket.ticketId, mode: 'reflection' }
      return { ok: true, ticketId: ticket.ticketId, status: 'open' }
    },
    state: {
      ticketMeta: id => meta[id] || { ticketId: id },
      setTicketMeta: (id, patch) => Object.assign(meta[id] || (meta[id] = { ticketId: id }), patch),
    },
  }

  const first = await service.startReflectionRun({ forDate: '2026-11-20' })
  assert.equal(first.ok, true)
  assert.equal(first.queued, true)
  assert.equal(first.runId, 'ticket_reflect_1')
  assert.equal(first.reflectionTicketId, 'ticket_reflect_1')
  assert.equal(first.forDate, '2026-11-20')
  assert.equal(creates, 1)
  assert.equal(readReflectionState(dir).activeRunId, 'ticket_reflect_1')
  assert.equal(service.reflectionStatusSummary().activeRunId, 'ticket_reflect_1')
  assert.equal(meta['ticket_reflect_1'].reflectionForDate, '2026-11-20')
  assert.equal(meta['ticket_reflect_1'].reflectionTrigger, 'manual')

  const second = await service.startReflectionRun({ forDate: '2026-11-20' })
  assert.equal(second.already_running, true)
  assert.equal(second.alreadyActive, true)
  assert.equal(second.runId, 'ticket_reflect_1')
  assert.equal(creates, 1, 'duplicate forDate must not create another ticket')
  assert.equal(events.filter(event => event.event === 'reflection.run.already_active').length, 1,
    'duplicate trigger must record exactly one already_active event')

  // A terminal active ticket must be cleared before a different date can start.
  tickets[0].status = 'done'
  assert.equal(service.reflectionStatusSummary().activeRunId, null, 'terminal ticket is not an active run')

  nextStatus = { ok: false, code: 'advisor_unavailable', message: 'no reflection executor' }
  const failed = await service.startReflectionRun({ forDate: '2026-11-21' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'advisor_unavailable')
  assert.match(failed.message, /no reflection executor/)

  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("url.pathname.endsWith('/reflection/run')")
  const end = source.indexOf("url.pathname.endsWith('/ensure')", start)
  assert.ok(start >= 0 && end > start, 'reflection/run handler exists')
  const handler = source.slice(start, end)
  assert.match(handler, /startReflectionRun/)
  assert.doesNotMatch(handler, /sessionController[.]prompt/, 'handler must not prompt Chat')
  assert.match(handler, /202/)
  assert.match(handler, /503/)
  console.log('reflection run api ok')
} finally { rmSync(dir, { recursive: true, force: true }) }