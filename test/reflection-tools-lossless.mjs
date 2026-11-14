import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { querySession, reflectionDate } from '../lib/reflection.mjs'

function undefinedPath(value, path = '$') {
  if (value === undefined) return path
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return path + '[' + index + '] (hole)'
      const found = undefinedPath(value[index], path + '[' + index + ']')
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = undefinedPath(value[key], path + '.' + key)
      if (found) return found
    }
  }
  return null
}

function assertLossless(label, value) {
  const found = undefinedPath(value)
  assert.equal(found, null, label + ' contains undefined at ' + found)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, label + ' is not lossless JSON')
}

const at = Date.now()
const fixture = await createFixture({
  sessionEvents: {
    'session-worker': [
      { type: 'user/message', time: at - 2000, data: { content: [{ type: 'text', text: '请检查日志' }], source: { kind: 'user' } } },
      { type: 'assistant/message', time: at - 1000, data: { content: [{ type: 'text', text: '好的，我来看看。' }] } },
    ],
  },
})
const { service, stateDir } = fixture

try {
  const legacy = service.store.addTicket({ goal: '历史完成工单：补文档', status: 'done', executor: 'session-worker' })
  delete legacy.waitingOn
  legacy.blockedReason = ''
  const blocked = service.store.addTicket({ goal: '阻塞工单：等用户决定', status: 'blocked', executor: 'session-worker', waitingOn: 'user', blockedReason: '等用户确认' })

  const forDate = reflectionDate(Date.now())
  const begun = await fixture.call('ria_reflect', { action: 'begin', forDate })
  assert.equal(begun.ok, true, JSON.stringify(begun))
  const spawned = await fixture.call('ria_spawn', {
    cwd: stateDir,
    agentPreset: 'minimal',
    reflectionRunId: begun.runId,
    title: 'Ria 反省 ' + forDate,
  })
  assert.equal(spawned.ok, true, JSON.stringify(spawned))
  const worker = spawned.sessionId
  const dispatched = await fixture.call('ria_reflect', { action: 'dispatch', runId: begun.runId, sessionId: worker })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))

  const tools = fixture.agentTools.get(worker)
  const callTool = (name, args = {}) => tools.get(name).execute(args, {
    agent: { id: worker },
    signal: new AbortController().signal,
    concludeTurn() {},
  })

  const outputs = [
    ['ria_reflect_status', {}],
    ['ria_reflect_read_tickets', { scope: 'window', limit: 20 }],
    ['ria_reflect_read_sessions', { scope: 'candidates' }],
    ['ria_reflect_read_session', { sessionId: 'session-worker', mode: 'summary' }],
    ['ria_reflect_read_context', { kind: 'memory' }],
    ['ria_reflect_report', { markdown: '# 测试报告\n', status: 'complete', counts: { sessions: 1 } }],
  ]
  for (const [name, args] of outputs) {
    assert.ok(tools.has(name), name + ' is not installed')
    const value = await callTool(name, args)
    assertLossless(name, value)
  }

  const tickets = await callTool('ria_reflect_read_tickets', { scope: 'window' })
  assert.ok(tickets.tickets.some(ticket => ticket.ticketId === legacy.ticketId), 'legacy ticket is missing')
  assert.ok(tickets.tickets.some(ticket => ticket.ticketId === blocked.ticketId), 'blocked ticket is missing')

  const run = service.reflectionRunById(begun.runId)
  const direct = querySession({
    run,
    events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '没有时间戳' }] } }],
    mode: 'full',
    refs: ['e0'],
    seenRefs: new Set(['e0']),
  })
  assertLossless('querySession', direct)

  console.log('reflection tools lossless ok')
} finally {
  fixture.cleanup()
}
