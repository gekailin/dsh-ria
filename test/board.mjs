import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createFixture } from './support/ria-fixture.mjs'

function loadBoardLayout() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('/* board-layout:start */')
  const end = source.indexOf('/* board-layout:end */')
  assert.ok(start >= 0 && end > start, 'client board layout markers')
  const block = source.slice(start, end)
  const api = new Function(block + '\nreturn { boardLayout, boardMatchesFilter, boardFilteredTickets, boardFocusScroll, BOARD_FILTERS, BOARD_DEFAULT_FILTER, BOARD_CARD_WIDTH, BOARD_CARD_HEIGHT, BOARD_LANE_WIDTH, BOARD_PAD_X };')()
  return { source, ...api }
}

function loadBoardTooltip() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('/* board-tooltip:start */')
  const end = source.indexOf('/* board-tooltip:end */')
  assert.ok(start >= 0 && end > start, 'client board tooltip markers')
  const block = source.slice(start, end)
  const api = new Function(block + '\nreturn { boardChecklistView, BOARD_CHECKLIST_LIMIT };')()
  return { source, ...api }
}

function loadBoardInteraction() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('/* board-interaction:start */')
  const end = source.indexOf('/* board-interaction:end */')
  assert.ok(start >= 0 && end > start, 'client board interaction markers')
  const block = source.slice(start, end)
  const api = new Function(block + '\nreturn { BOARD_TOOLTIP_CLOSE_DELAY, BOARD_COPY_TOAST_MS, boardCopyTarget, boardCopyMessage, boardManualCopyMessage, boardTipContains, boardLegacyCopy, boardWriteClipboard };')()
  return { source, ...api }
}

const fixture = await createFixture()

function get(path) {
  const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
  assert.ok(route, 'API route registered')
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  route.handler(req, res)
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

try {
  const upstream = await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })
  const downstream = await fixture.call('ria_ticket', {
    goal: 'edit the draft',
    executor: 'session-worker',
    dependsOn: [upstream.ticket.ticketId],
  })
  const blocked = await fixture.call('ria_ticket', {
    goal: 'needs a decision',
    executor: 'session-worker',
    status: 'blocked',
    blockedReason: 'waiting for user',
  })
  const orphan = await fixture.call('ria_ticket', { goal: 'old ghost worker', executor: 'session-ghost' })
  const selfTicket = await fixture.call('ria_ticket', { goal: 'Ria handles this itself', executor: 'self' })

  const response = await get('/plugins/dsh-ria/api/board')
  assert.equal(response.status, 200)
  const board = response.body
  assert.equal(board.ok, true)
  assert.equal(board.riaSessionId, fixture.service.store.riaSessionId)
  assert.equal(board.counts.total, 5)
  assert.equal(board.counts.active, 5)
  assert.equal(board.counts.blocked, 1)

  const byId = new Map(board.tickets.map(ticket => [ticket.ticketId, ticket]))
  assert.equal(byId.get(upstream.ticket.ticketId).status, 'open')
  assert.equal(byId.get(downstream.ticket.ticketId).queueState, 'waiting_dependency')
  assert.deepEqual(byId.get(downstream.ticket.ticketId).dependsOn, [upstream.ticket.ticketId])
  assert.equal(byId.get(upstream.ticket.ticketId).dependentCount, 1)
  assert.equal(byId.get(downstream.ticket.ticketId).dependentCount, 0)
  assert.equal(byId.get(upstream.ticket.ticketId).archived, false)
  assert.equal(byId.get(blocked.ticket.ticketId).status, 'blocked')
  assert.equal(byId.get(blocked.ticket.ticketId).blockedReason, 'waiting for user')
  assert.equal(byId.get(upstream.ticket.ticketId).executorTitle, 'Worker One')
  assert.ok(byId.get(upstream.ticket.ticketId).laneId.startsWith('path:'))

  const self = byId.get(selfTicket.ticket.ticketId)
  assert.equal(self.executor, 'self')
  assert.equal(self.laneId, 'ria')
  assert.equal(self.executorTitle, 'Ria')
  assert.equal(self.executorMissing, false)

  const ghost = byId.get(orphan.ticket.ticketId)
  assert.equal(ghost.executorMissing, true)
  assert.equal(ghost.laneId, 'unassigned')
  assert.equal(ghost.laneLabel, '未分配')

  const lanes = board.lanes.map(lane => lane.id)
  assert.ok(lanes.includes('unassigned'))
  assert.equal(board.lanes.find(lane => lane.id === 'unassigned').total, 1)

  // Broken workspace metadata must not take the endpoint down.
  const original = fixture.ctx.workspaceRegistry.list
  fixture.ctx.workspaceRegistry.list = () => { throw new Error('registry offline') }
  const tolerant = await fixture.service.boardData()
  assert.equal(tolerant.ok, true)
  assert.equal(tolerant.counts.total, 5)
  fixture.ctx.workspaceRegistry.list = original

  // An archived executor is still drawn, but flagged so the UI can say so.
  const archivedFixture = await createFixture({ archivedSessionIds: ['session-worker'] })
  try {
    await archivedFixture.call('ria_ticket', { goal: 'archived worker', executor: 'session-worker' })
    const archivedBoard = await archivedFixture.service.boardData()
    assert.equal(archivedBoard.tickets[0].executorArchived, true)
  } finally {
    archivedFixture.cleanup()
  }

  // Pagination reads backwards from the newest ticket, and the cursor must
  // include archived tickets because they only exist in the archive logs.
  const pageFixture = await createFixture()
  try {
    const pageStore = pageFixture.service.store
    const base = Date.now() - 300000
    const created = []
    for (let index = 0; index < 3; index += 1) {
      const ticket = pageStore.addTicket({ goal: 'page ' + index, executor: 'session-worker' })
      pageStore.ticket(ticket.ticketId).createdAt = base + index * 1000
      created.push(ticket.ticketId)
    }
    pageStore.save()
    const latest = await pageFixture.service.boardData({ limit: 2 })
    assert.equal(latest.page.returned, 2)
    assert.equal(latest.page.total, 3)
    assert.equal(latest.page.hasMore, true)
    assert.deepEqual(latest.tickets.map(ticket => ticket.ticketId), [created[1], created[2]])
    assert.equal(latest.page.nextBefore, base + 1000)
    const older = await pageFixture.service.boardData({ limit: 2, before: latest.page.nextBefore })
    assert.equal(older.page.returned, 1)
    assert.equal(older.page.hasMore, false)
    assert.deepEqual(older.tickets.map(ticket => ticket.ticketId), [created[0]])
    const viaRoute = await (async () => {
      const old = pageFixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
      const req = new EventEmitter()
      req.method = 'GET'
      req.url = '/plugins/dsh-ria/api/board?limit=1&before=' + encodeURIComponent(String(base + 1500))
      req.headers = { host: '127.0.0.1:3080' }
      const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body; this.done(body) } }
      const done = new Promise(resolve => { res.done = resolve })
      old.handler(req, res)
      const body = await done
      return { status: res.statusCode, body: JSON.parse(body) }
    })()
    assert.equal(viaRoute.status, 200)
    assert.equal(viaRoute.body.page.returned, 1)
    assert.equal(viaRoute.body.tickets[0].ticketId, created[1])
    const bad = await get('/plugins/dsh-ria/api/board?limit=0')
    assert.equal(bad.status, 400)
  } finally {
    pageFixture.cleanup()
  }

  const archiveFixture = await createFixture()
  try {
    const archiveStore = archiveFixture.service.store
    const ticket = archiveStore.addTicket({ goal: 'archived on the board', executor: 'session-worker' })
    const recordTicket = archiveStore.ticket(ticket.ticketId)
    recordTicket.status = 'done'
    recordTicket.closedAt = Date.now() - 1000
    recordTicket.updatedAt = recordTicket.closedAt
    archiveStore.appendArchiveLines(archiveStore.ticketLogFile('tickets.log.jsonl'), [archiveStore.archiveRecord(recordTicket)])
    archiveStore.data.tickets = archiveStore.data.tickets.filter(item => item.ticketId !== ticket.ticketId)
    archiveStore.save()
    const archivedBoard = await archiveFixture.service.boardData({ limit: 60 })
    assert.equal(archivedBoard.counts.total, 1)
    assert.equal(archivedBoard.counts.terminal, 1)
    assert.equal(archivedBoard.tickets[0].ticketId, ticket.ticketId)
    assert.equal(archivedBoard.tickets[0].archived, true)
    assert.equal(archivedBoard.tickets[0].status, 'done')
  } finally {
    archiveFixture.cleanup()
  }

  // Board layout: every project owns a horizontal band, and rows are packed
  // inside the band so a card can never drift into another project.
  const layoutApi = loadBoardLayout()
  const layoutTickets = [
    { ticketId: 'a0', laneId: 'workspace:ria', createdAt: 1, dependsOn: ['u6'], goal: 'a0' },
    { ticketId: 'a1', laneId: 'workspace:ria', createdAt: 2, dependsOn: [], goal: 'a1' },
    { ticketId: 'a2', laneId: 'workspace:ria', createdAt: 3, dependsOn: [], goal: 'a2' },
    { ticketId: 'b0', laneId: 'workspace:vggt', createdAt: 4, dependsOn: [], goal: 'b0' },
    { ticketId: 'b1', laneId: 'workspace:vggt', createdAt: 5, dependsOn: [], goal: 'b1' },
    { ticketId: 'b2', laneId: 'workspace:vggt', createdAt: 6, dependsOn: [], goal: 'b2' },
    { ticketId: 'u6', laneId: 'unassigned', createdAt: 7, dependsOn: [], goal: 'u6' },
  ]
  const layoutLanes = [
    { id: 'workspace:ria', label: 'dsh-ria' },
    { id: 'workspace:vggt', label: 'vggt' },
    { id: 'unassigned', label: '未分配' },
  ]
  const layout = layoutApi.boardLayout(layoutTickets, layoutLanes)
  const bandById = new Map(layout.bands.map(band => [band.id, band]))
  const position = id => layout.positions.get(id)

  assert.deepEqual(layout.bands.map(band => band.id), ['workspace:ria', 'workspace:vggt', 'unassigned'])
  assert.deepEqual(layout.bands.map(band => band.label), ['dsh-ria', 'vggt', '未分配'])
  assert.equal(layout.bands.at(-1).id, 'unassigned')

  for (const id of ['a0', 'a1', 'a2']) assert.equal(position(id).band, 'workspace:ria')
  for (const id of ['b0', 'b1', 'b2']) assert.equal(position(id).band, 'workspace:vggt')
  assert.equal(position('u6').band, 'unassigned')

  for (const band of layout.bands) {
    const slots = new Set()
    const members = [...layout.positions.entries()].filter(([, item]) => item.band === band.id)
    assert.ok(members.length > 0, band.id + ' has cards')
    for (const [id, item] of members) {
      const slot = item.column + ':' + item.row
      assert.ok(!slots.has(slot), 'band ' + band.id + ' slot ' + slot + ' is not reused by ' + id)
      slots.add(slot)
      assert.ok(item.y >= band.y, id + ' starts inside its band')
      assert.ok(item.y + layoutApi.BOARD_CARD_HEIGHT <= band.y + band.height, id + ' stays inside its band')
    }
  }

  // Height follows the rows each band actually needs.
  assert.ok(bandById.get('workspace:vggt').height > bandById.get('workspace:ria').height)
  assert.ok(bandById.get('workspace:ria').height > bandById.get('unassigned').height)

  // A dependency may point across bands without moving the card out of its own.
  assert.ok(position('u6').x < position('a0').x)
  const crossEdge = layout.edges.find(edge => edge.from === 'u6' && edge.to === 'a0')
  assert.ok(crossEdge, 'cross-band dependency edge')
  assert.notEqual(position(crossEdge.from).band, position(crossEdge.to).band)
  assert.equal(crossEdge.d.includes((position('u6').y + layoutApi.BOARD_CARD_HEIGHT / 2).toFixed(1)), true)

  // The ruler starts after the fixed project label gutter.
  assert.ok(layout.ticks.every(tick => tick.x >= layoutApi.BOARD_PAD_X + layoutApi.BOARD_LANE_WIDTH))

  // A lane with no title falls back to the last segment of its cwd.
  const fallback = layoutApi.boardLayout([
    { ticketId: 'm1', laneId: 'path:/home/gkl/Desktop/vibe_proj/misc', createdAt: 1, dependsOn: [], goal: 'm1' },
    { ticketId: 'm2', laneId: 'unassigned', createdAt: 2, dependsOn: [], goal: 'm2' },
  ], [
    { id: 'path:/home/gkl/Desktop/vibe_proj/misc', label: '', cwd: '/home/gkl/Desktop/vibe_proj/misc' },
    { id: 'unassigned', label: '未分配' },
  ])
  assert.equal(fallback.bands[0].label, 'misc')
  assert.equal(fallback.bands.at(-1).label, '未分配')

  // The label gutter is a sticky overlay, not a column that scrolls away.
  const labelAt = layoutApi.source.indexOf('"data-ria-band-label"')
  assert.ok(labelAt > 0)
  const labelBlock = layoutApi.source.slice(labelAt, labelAt + 700)
  assert.match(labelBlock, /position:\s*"sticky"/)
  assert.match(labelBlock, /left:\s*"10px"/)

  // Status tabs only dim the cards they do not match. Search still narrows the
  // canvas, but the tab choice never changes how many cards are laid out.
  assert.equal(layoutApi.BOARD_DEFAULT_FILTER, 'active')
  assert.deepEqual(layoutApi.BOARD_FILTERS.map(item => item.id), ['all', 'active', 'blocked', 'done', 'cancelled'])
  assert.match(layoutApi.source, /useState\(BOARD_DEFAULT_FILTER\)/)
  const filterTickets = [
    { ticketId: 'f-open', status: 'open', laneId: 'workspace:ria', createdAt: 1, dependsOn: [], goal: 'open' },
    { ticketId: 'f-working', status: 'working', laneId: 'workspace:ria', createdAt: 2, dependsOn: [], goal: 'working' },
    { ticketId: 'f-blocked', status: 'blocked', laneId: 'workspace:ria', createdAt: 3, dependsOn: [], goal: 'blocked' },
    { ticketId: 'f-done', status: 'done', laneId: 'workspace:ria', createdAt: 4, dependsOn: [], goal: 'done' },
    { ticketId: 'f-cancelled', status: 'cancelled', laneId: 'workspace:ria', createdAt: 5, dependsOn: [], goal: 'cancelled' },
    { ticketId: 'f-forked', status: 'forked', laneId: 'workspace:ria', createdAt: 6, dependsOn: [], goal: 'forked' },
  ]
  const matches = (id, filter) => layoutApi.boardMatchesFilter(filterTickets.find(ticket => ticket.ticketId === id), filter)
  assert.equal(matches('f-open', 'active'), true)
  assert.equal(matches('f-working', 'active'), true)
  assert.equal(matches('f-blocked', 'active'), true)
  assert.equal(matches('f-done', 'active'), false)
  assert.equal(matches('f-cancelled', 'active'), false)
  assert.equal(matches('f-forked', 'active'), false)
  assert.equal(matches('f-blocked', 'blocked'), true)
  assert.equal(matches('f-open', 'blocked'), false)
  assert.equal(matches('f-done', 'done'), true)
  assert.equal(matches('f-forked', 'done'), false)
  assert.equal(matches('f-cancelled', 'cancelled'), true)
  assert.equal(matches('f-done', 'cancelled'), false)

  const baseTickets = layoutApi.boardFilteredTickets(filterTickets, '')
  assert.equal(baseTickets.length, filterTickets.length)
  assert.equal(layoutApi.boardFilteredTickets(filterTickets, 'blocked').length, 1)
  const allTabsLayout = layoutApi.boardLayout(baseTickets, layoutLanes)
  assert.equal(allTabsLayout.positions.size, filterTickets.length)
  assert.match(layoutApi.source, /boardLayout\(base, board && board\.lanes\)/)
  assert.match(layoutApi.source, /view\.base\.map/)
  assert.doesNotMatch(layoutApi.source, /view\.visible/)

  // Center the viewport on the leftmost/rightmost matching cards, including
  // the card width; irrelevant statuses outside that span must not move it.
  const focusLayout = {
    width: 2000,
    positions: new Map([
      ['f-open', { x: 700 }],
      ['f-working', { x: 700 }],
      ['f-blocked', { x: 1100 }],
      ['f-done', { x: 100 }],
      ['f-cancelled', { x: 1500 }],
      ['f-forked', { x: 1800 }],
    ]),
  }
  assert.equal(layoutApi.boardFocusScroll(focusLayout, filterTickets, 'active', 800), 580)
  assert.equal(layoutApi.boardFocusScroll(focusLayout, filterTickets, 'done', 800), 0)
  assert.equal(layoutApi.boardFocusScroll(focusLayout, filterTickets, 'blocked', 800), 780)
  assert.equal(layoutApi.boardFocusScroll(focusLayout, [
    { ticketId: 'f-done', status: 'done', goal: 'done' },
  ], 'active', 800), null)
  const clampLayout = {
    width: 2000,
    positions: new Map([['f-blocked', { x: 1900 }]]),
  }
  assert.equal(layoutApi.boardFocusScroll(clampLayout, filterTickets, 'blocked', 800), 1200)

  // User-facing copy calls a ticket a 工单, while ids and API fields stay unchanged.
  assert.match(layoutApi.source, /正在加载更早的工单…/)
  assert.match(layoutApi.source, /counts\.total \+ " 张工单 · 活跃 "/)
  assert.match(layoutApi.source, /向左滚动加载更早的工单/)
  assert.match(layoutApi.source, /搜索目标或工单 ID/)
  assert.match(layoutApi.source, /\["工单", ticket\.ticketId\]/)
  assert.doesNotMatch(layoutApi.source, /加载更早的票|搜索目标或 ticket id/)

  // The tooltip lists checklist steps instead of only the progress ratio.
  const tooltipApi = loadBoardTooltip()
  assert.equal(tooltipApi.BOARD_CHECKLIST_LIMIT, 6)
  const many = tooltipApi.boardChecklistView({
    checklist: [
      { text: '读取现有实现', done: true },
      { text: '补 schema 迁入', done: true },
      { text: '写接口', done: true },
      { text: '补测试', done: false },
      { text: '更新文档', done: false },
      { text: '截图复核', done: false },
      { text: '清理临时目录', done: false },
      { text: '提交', done: false },
    ],
  })
  assert.equal(many.items.length, 6)
  assert.deepEqual(many.items.map(item => item.done), [true, true, true, false, false, false])
  assert.equal(many.items[0].text, '读取现有实现')
  assert.equal(many.items[5].text, '截图复核')
  assert.equal(many.more, 2)

  const short = tooltipApi.boardChecklistView({
    checklist: [{ text: '只做一步', done: true }, { text: '然后再走一步', done: false }],
  })
  assert.equal(short.items.length, 2)
  assert.equal(short.more, 0)

  const empty = tooltipApi.boardChecklistView({ checklist: [] })
  assert.deepEqual(empty.items, [])
  assert.equal(empty.more, 0)
  assert.equal(tooltipApi.boardChecklistView({}).items.length, 0)

  // Completed steps use a tick and normal text, pending ones an open circle
  // and a lighter colour; long steps ellipsize instead of wrapping.
  assert.match(tooltipApi.source, /item\.done \? "✓" : "○"/)
  assert.match(tooltipApi.source, /color: item\.done \? "#334155" : "#94a3b8"/)
  assert.match(tooltipApi.source, /textOverflow: "ellipsis"/)
  assert.match(tooltipApi.source, /whiteSpace: "nowrap"/)
  assert.match(tooltipApi.source, /…还有 " \+ checklist\.more \+ " 步/)
  assert.match(tooltipApi.source, /checklist\.items\.length \? checklistRow\(\) : null/)
  assert.match(tooltipApi.source, /maxHeight: "calc\(100vh - 40px\)"/)
  assert.match(tooltipApi.source, /window\.innerHeight - rect\.height - margin/)
  assert.match(tooltipApi.source, /单击卡片复制单号；浮层文字可选中复制/)

  // Clicking a card copies its ticket id; the tooltip stays alive while the
  // pointer crosses the gap and can be dismissed by an outside click or Esc.
  const interaction = loadBoardInteraction()
  assert.ok(interaction.BOARD_TOOLTIP_CLOSE_DELAY >= 200)
  assert.ok(interaction.BOARD_TOOLTIP_CLOSE_DELAY <= 300)
  assert.equal(interaction.BOARD_COPY_TOAST_MS, 2000)
  assert.equal(interaction.boardCopyTarget({ ticketId: 'ticket_abc' }), 'ticket_abc')
  assert.equal(interaction.boardCopyTarget({ ticketId: 7 }), '')
  assert.equal(interaction.boardCopyTarget({}), '')
  assert.equal(interaction.boardCopyTarget(null), '')
  assert.equal(interaction.boardCopyMessage('ticket_abc'), '已复制 ticket_abc')
  assert.equal(interaction.boardManualCopyMessage('ticket_abc'), '复制失败，请手动选中复制：ticket_abc')

  const child = {}
  const tipNode = { contains: node => node === child }
  assert.equal(interaction.boardTipContains(tipNode, tipNode), true)
  assert.equal(interaction.boardTipContains(tipNode, child), true)
  assert.equal(interaction.boardTipContains(tipNode, {}), false)
  assert.equal(interaction.boardTipContains(null, child), false)
  assert.equal(interaction.boardTipContains(tipNode, null), false)

  assert.match(interaction.source, /if \(props\.onCopy\) props\.onCopy\(ticket\)/)
  assert.match(interaction.source, /onCopy: copyTicket/)
  assert.match(interaction.source, /onLeave: scheduleHideTip/)
  assert.match(interaction.source, /onEnter: cancelHideTip/)
  assert.match(interaction.source, /pointerEvents: "auto"/)
  assert.match(interaction.source, /userSelect: "text"/)
  assert.match(interaction.source, /document\.addEventListener\("pointerdown", onPointerDown, true\)/)
  assert.match(interaction.source, /event\.key !== "Escape"/)
  assert.match(interaction.source, /\}, BOARD_TOOLTIP_CLOSE_DELAY\)/)
  assert.match(interaction.source, /setCopy\(null\); \}, BOARD_COPY_TOAST_MS\)/)
  assert.match(interaction.source, /role: "status"/)
  assert.match(interaction.source, /role: "alert"/)
  assert.match(interaction.source, /"data-ria-board-copy": "ok"/)
  assert.match(interaction.source, /"data-ria-board-copy": "error"/)

  console.log('board ok')
} finally {
  fixture.cleanup()
}
