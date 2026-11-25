import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createFixture } from './support/ria-fixture.mjs'

// The board list is a lean projection: it must carry only what the board
// renders, never the full markdown goal / acceptance / checklist / reports.
// The detail endpoint is the only source of the full ticket, fetched lazily by
// the dialog (GET /tickets/:ticketId).

const goal = '# 目标\n\n- 实现列表精简投影。后续还有一整段不会出现在列表里的目标说明。' + '补充说明'.repeat(120)
const acceptance = '| 项 | 值 |\n| --- | --- |\n| 验收 | 详情接口返回完整工单 |' + '验收细节'.repeat(80)
const fixture = await createFixture({ stateDefault: true })
const skipKeys = ['goal', 'acceptance', 'checklist', 'attention', 'blockedReason', 'queueState', 'queueText', 'dependentCount', 'history', 'resolution', 'reports', 'workOrder', 'meta']
try {
  const state = fixture.service.controller.state
  state.addExecutor('session-executor', {
    kind: 'managed', executorType: 'work', cwd: '/tmp/ria-board-lean-test', status: 'idle',
    tags: ['frontend', 'board'], roleNote: '看板 UI',
  })
  const ticket = fixture.service.store.addTicket({
    goal,
    acceptance,
    status: 'open',
    executor: 'session-executor',
    checklist: [{ text: 'step one', done: false }, { text: 'step two', done: true }],
  })
  state.setTicketMeta(ticket.ticketId, { routingTags: ['frontend', 'board'] })
  state.setWorkOrder(ticket.ticketId, { summary: 'work order body', steps: [{ id: 's1', text: 'do it' }] })
  state.addReport({ reportId: 'report-lean-1', ticketId: ticket.ticketId, status: 'done', summary: 'report summary', evidence: ['file:lib/index.js:L10-L20'], at: Date.now() })
  const second = fixture.service.store.addTicket({ goal: 'short goal', acceptance: 'x', status: 'working', executor: 'session-executor' })

  let listCalls = 0
  let resolveCalls = 0
  let detailCalls = 0
  const sessionController = fixture.ctx.sessionController
  const originalList = sessionController.list.bind(sessionController)
  const originalResolve = sessionController.resolveAgent.bind(sessionController)
  sessionController.list = async (...args) => { listCalls += 1; return originalList(...args) }
  sessionController.resolveAgent = async (...args) => { resolveCalls += 1; return originalResolve(...args) }
  const originalDetail = fixture.service.boardTicketDetail.bind(fixture.service)
  fixture.service.boardTicketDetail = async (...args) => { detailCalls += 1; return originalDetail(...args) }
  try {
    const board = await fixture.service.boardData({ limit: 60 })
    // One batched session listing for lanes/titles, never one per row; and the
    // list must not read any ticket detail or executor transcript.
    assert.equal(listCalls, 1, 'board list uses one session listing, not N+1')
    assert.equal(resolveCalls, 0, 'board list must not resolve executors')
    assert.equal(detailCalls, 0, 'board list must not fetch ticket details')

    const models = [board.tickets, board.searchIndex]
    for (const list of models) {
      for (const item of list) {
        for (const key of skipKeys) assert.equal(Object.hasOwn(item, key), false, 'lean ticket must not carry ' + key)
        for (const key of ['ticketId', 'title', 'status', 'executor', 'executorId', 'executorTitle', 'createdAt', 'updatedAt', 'closedAt', 'archived', 'archivedAt', 'routingTags']) {
          assert.ok(Object.hasOwn(item, key), 'lean ticket field missing: ' + key)
        }
      }
    }
    const view = board.tickets.find(item => item.ticketId === ticket.ticketId)
    assert.equal(view.title, '实现列表精简投影', 'title is the first goal sentence, not the full goal')
    assert.ok(!JSON.stringify(board).includes('补充说明补充说明'), 'full goal text never enters the list payload')
    assert.ok(!JSON.stringify(board).includes('验收细节'), 'acceptance text never enters the list payload')
    for (const key of ['"goal":', '"acceptance":', '"checklist":', '"resolution":', '"history":', '"reports":', '"workOrder":']) {
      assert.ok(!JSON.stringify(board).includes(key), 'list payload must not carry ' + key)
    }
    assert.deepEqual(view.routingTags, ['frontend', 'board'], 'routingTags are part of the lean projection')
    assert.equal(view.progressText, '1/2', 'list carries only the checklist progress badge, not the checklist')
    assert.ok(board.tickets.some(item => item.ticketId === second.ticketId && item.title === 'short goal'))

    // Detail: the full ticket, work order, reports/evidence and metadata.
    const detail = await fixture.service.boardTicketDetail(ticket.ticketId)
    assert.equal(detail.ok, true)
    assert.equal(detail.ticket.goal, goal, 'detail returns the untruncated goal')
    assert.equal(detail.ticket.acceptance, acceptance, 'detail returns the untruncated acceptance')
    assert.equal(detail.ticket.checklist.length, 2)
    assert.ok(Array.isArray(detail.ticket.history))
    assert.equal(detail.workOrder.summary, 'work order body')
    assert.equal(detail.reports.length, 1)
    assert.deepEqual(detail.evidence, ['file:lib/index.js:L10-L20'])
    assert.deepEqual(detail.meta.routingTags, ['frontend', 'board'])
    assert.equal(detail.context.queueState, 'ready')
    assert.equal(typeof detail.context.queueText, 'string')
    assert.deepEqual(detail.context.executorTags, ['frontend', 'board'])
    assert.equal(detail.context.executorRoleNote, '看板 UI')
    assert.equal(detail.ticketId, ticket.ticketId)

    const missing = await fixture.service.boardTicketDetail('ticket-does-not-exist')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'ticket_missing')
    assert.match(missing.message, /ticket not found/)
  } finally {
    sessionController.list = originalList
    sessionController.resolveAgent = originalResolve
    fixture.service.boardTicketDetail = originalDetail
  }

  // HTTP contract: the REST detail route is what the dialog calls.
  const server = createServer((req, res) => fixture.service.httpHandler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = 'http://127.0.0.1:' + server.address().port + '/plugins/dsh-ria/api'
  const get = async path => {
    const response = await fetch(api + path)
    return { status: response.status, body: await response.json() }
  }
  try {
    const ok = await get('/tickets/' + encodeURIComponent(ticket.ticketId))
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.ticket.goal, goal)

    const legacy = await get('/board/ticket?ticketId=' + encodeURIComponent(ticket.ticketId))
    assert.equal(legacy.status, 200, 'legacy query-string route stays as an alias')

    const notFound = await get('/tickets/ticket-does-not-exist')
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body.ok, false)
    assert.equal(notFound.body.code, 'ticket_missing')
    assert.match(notFound.body.message, /ticket not found/)

    const originalDetail = fixture.service.boardTicketDetail
    fixture.service.boardTicketDetail = async () => { throw new Error('detail backend exploded') }
    try {
      const failed = await get('/tickets/' + encodeURIComponent(ticket.ticketId))
      assert.equal(failed.status, 500)
      assert.equal(failed.body.ok, false)
      assert.equal(failed.body.code, 'ticket_detail_failed')
      assert.match(failed.body.error, /detail backend exploded/)
    } finally {
      fixture.service.boardTicketDetail = originalDetail
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  // SQL layer: no SELECT * on the ticket read path; the adapter names columns.
  const adapter = readFileSync(new URL('../lib/state/sqlite/adapter.mjs', import.meta.url), 'utf8')
  assert.ok(!/SELECT \* FROM tickets/.test(adapter), 'ticket reads must not use SELECT *')
  assert.match(adapter, /const TICKET_COLUMNS =/)
  const runtime = readFileSync(new URL('../lib/state/sqlite/runtime.mjs', import.meta.url), 'utf8')
  assert.ok(!/SELECT \* FROM topics/.test(runtime), 'topic reads must not use SELECT *')
  assert.ok(!/SELECT \* FROM topic_links/.test(runtime), 'topic link reads must not use SELECT *')

  // Client: list renders title, dialog fetches detail lazily with loading,
  // retry and a short-lived cache; section/markdown rendering is untouched.
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('function boardTicketTitle'))
  assert.ok(!client.includes('boardShortTitle(ticket.goal)'), 'list cards no longer derive titles from the full goal')
  assert.match(client, /boardTicketTitle\(ticket\)/)
  assert.match(client, /"\/tickets\/" \+ encodeURIComponent\(ticketId\)/)
  assert.match(client, /data-ria-ticket-detail-loading/)
  assert.match(client, /data-ria-ticket-detail-error/)
  assert.match(client, /data-ria-ticket-detail-retry/)
  assert.match(client, /TICKET_DETAIL_CACHE_TTL_MS = 30000/)
  assert.match(client, /function readTicketDetailCache/)
  assert.match(client, /"\/board\/ticket\?ticketId="/, 'previous-build hosts still get the legacy alias as a fallback')
  assert.ok(!client.includes('dangerouslySetInnerHTML'))
  console.log('board ticket list projection ok')
} finally {
  fixture.cleanup()
}
