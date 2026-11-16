import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { managerPrompt } from '../lib/index.js'
import { linkTopic, mergeTopicLinks, normalizeLink, normalizeLinks, normalizeTopic, normalizeTopics, topicProgressCounts, topicSummaryInfo } from '../lib/topics.mjs'

// Topic records are tolerant on load: missing optional fields are fine, bad
// records are dropped, and only the first primary link of a ticket survives.
{
  const topic = normalizeTopic({ topicId: 'topic_a', title: '  Release  ' })
  assert.equal(topic.title, 'Release')
  assert.equal(topic.level, 1)
  assert.equal(topic.brief, '')
  assert.equal(topic.parentId, null)
  assert.ok(topic.createdAt > 0)
  assert.equal(normalizeTopic({ topicId: '', title: 'x' }), undefined)
  assert.equal(normalizeTopic({ topicId: 't', title: '' }), undefined)
  assert.deepEqual(normalizeTopics([{ topicId: 'topic_a', title: 'A' }, { topicId: 'topic_a', title: 'dup' }, null]).map(item => item.title), ['A'])

  const link = normalizeLink({ topicId: 'topic_a', ticketId: 'ticket_1' })
  assert.equal(link.role, 'related')
  const links = normalizeLinks([
    { topicId: 'topic_a', ticketId: 'ticket_1', role: 'primary' },
    { topicId: 'topic_b', ticketId: 'ticket_1', role: 'primary' },
    { topicId: 'topic_a', ticketId: 'ticket_1', role: 'related' },
    { topicId: 'topic_b', ticketId: 'ticket_2', role: 'related' },
  ])
  assert.equal(links.length, 3)
  assert.equal(links.find(item => item.topicId === 'topic_a' && item.ticketId === 'ticket_1').role, 'primary')
  assert.equal(links.find(item => item.topicId === 'topic_b' && item.ticketId === 'ticket_1').role, 'related')

  const promoted = linkTopic(links, 'topic_b', 'ticket_1', 'primary', 100)
  assert.equal(promoted.demoted, 'topic_a')
  assert.equal(promoted.links.find(item => item.topicId === 'topic_b' && item.ticketId === 'ticket_1').role, 'primary')
  assert.equal(promoted.links.find(item => item.topicId === 'topic_a' && item.ticketId === 'ticket_1').role, 'related')

  const merged = mergeTopicLinks(promoted.links, 'topic_b', 'topic_c', 200)
  assert.ok(merged.links.every(item => item.topicId !== 'topic_b'))
  assert.equal(merged.links.filter(item => item.topicId === 'topic_c' && item.ticketId === 'ticket_1').length, 1)
}

// A hand-written brief wins; otherwise the board derives a single sentence
// from the newest ticket and the same counts the card renders.
{
  assert.deepEqual(topicSummaryInfo({ brief: '  Human brief  ' }, []), { text: 'Human brief', auto: false })

  const views = [
    { ticketId: 'ticket_old', goal: 'older goal', status: 'open', updatedAt: 10 },
    { ticketId: 'ticket_new', goal: 'newest goal', status: 'blocked', updatedAt: 30 },
    { ticketId: 'ticket_done', goal: 'finished goal', status: 'done', updatedAt: 20 },
  ]
  assert.deepEqual(topicProgressCounts(views), { total: 3, open: 2, working: 0, blocked: 1, done: 1 })
  assert.deepEqual(topicSummaryInfo({}, views), { text: '「newest goal」卡住 · 待执行 2 · 已完成 1', auto: true })

  const statuses = [
    ['open', '待执行', '待执行 1'],
    ['working', '进行中', '执行中 1'],
    ['blocked', '卡住', '待执行 1'],
    ['done', '已完成', '已完成 1'],
    ['cancelled', '已取消', '已完成 1'],
  ]
  for (const [status, word, counts] of statuses) {
    const info = topicSummaryInfo({}, [{ goal: 'goal', status, updatedAt: 1 }])
    assert.equal(info.text, '「goal」' + word + ' · ' + counts)
    assert.equal(info.auto, true)
  }

  const mixed = topicProgressCounts(['open', 'working', 'blocked', 'done', 'failed', 'cancelled'].map(status => ({ status })))
  assert.deepEqual(mixed, { total: 6, open: 2, working: 1, blocked: 1, done: 3 })

  const longGoal = '很'.repeat(61)
  const truncated = topicSummaryInfo({}, [{ goal: longGoal, status: 'open', updatedAt: 1 }])
  assert.equal(truncated.text, '「' + '很'.repeat(60) + '…」待执行 · 待执行 1')
  assert.equal(truncated.text.includes(longGoal), false, 'the 61st character is dropped')
  assert.equal(topicSummaryInfo({}, []).text, '暂无工单')

  assert.deepEqual(topicSummaryInfo({ unclassified: true }, []), { text: '暂无工单', auto: true })
  assert.deepEqual(topicSummaryInfo({ unclassified: true }, [
    { goal: 'older loose idea', status: 'open', updatedAt: 3 },
    { goal: 'newest loose idea', status: 'open', updatedAt: 7 },
  ]), { text: '2 张待分类 · 最近：「newest loose idea」', auto: true })
}

const fixture = await createFixture()
const stateDir = fixture.stateDir

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
  const t1 = (await fixture.call('ria_ticket', { goal: 'write the draft', executor: 'session-worker' })).ticket
  const t2 = (await fixture.call('ria_ticket', { goal: 'edit the draft', executor: 'session-worker', dependsOn: [t1.ticketId] })).ticket
  const t3 = (await fixture.call('ria_ticket', { goal: 'collect references', executor: 'session-worker' })).ticket
  const t4 = (await fixture.call('ria_ticket', { goal: 'assemble the appendix', executor: 'session-worker', dependsOn: [t3.ticketId] })).ticket
  const t5 = (await fixture.call('ria_ticket', { goal: 'loose idea without a topic', executor: 'self' })).ticket
  assert.equal(fixture.service.store.transitionTicket(t3.ticketId, 'working', { executor: 'session-worker' }).ok, true)
  const done = fixture.service.store.transitionTicket(t3.ticketId, 'done', { resolution: { kind: 'answered', summary: 'done' } })
  assert.equal(done.ok, true)

  const topicA = await fixture.call('ria_topic', { action: 'create', title: 'Draft', brief: 'First topic' })
  assert.equal(topicA.ok, true)
  assert.ok(topicA.topic.topicId.startsWith('topic_'))
  const topicB = await fixture.call('ria_topic', { action: 'create', title: 'Appendix', level: 2 })
  assert.equal(topicB.ok, true)

  const linkedA = await fixture.call('ria_topic', { action: 'link', topicId: topicA.topic.topicId, ticketId: t1.ticketId })
  assert.equal(linkedA.ok, true)
  assert.equal(linkedA.role, 'primary')
  const linkedB2 = await fixture.call('ria_topic', { action: 'link', topicId: topicB.topic.topicId, ticketId: t2.ticketId })
  assert.equal(linkedB2.ok, true)
  const linkedB3 = await fixture.call('ria_topic', { action: 'link', topicId: topicB.topic.topicId, ticketId: t3.ticketId })
  assert.equal(linkedB3.ok, true)
  const linkedB4 = await fixture.call('ria_topic', { action: 'link', topicId: topicB.topic.topicId, ticketId: t4.ticketId })
  assert.equal(linkedB4.ok, true)

  const update = await fixture.call('ria_topic', { action: 'update', topicId: topicA.topic.topicId, brief: 'Updated brief' })
  assert.equal(update.topic.brief, 'Updated brief')
  const missing = await fixture.call('ria_topic', { action: 'update', topicId: 'topic_nope', brief: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'topic_missing')

  const boardResponse = await get('/plugins/dsh-ria/api/board')
  assert.equal(boardResponse.status, 200)
  const board = boardResponse.body
  assert.equal(board.ok, true)
  const project = board.projects.find(item => item.topics.some(topic => topic.topicId === topicA.topic.topicId))
  assert.ok(project, 'topic project exists')
  assert.ok(project.title && (project.projectId.startsWith('workspace:') || project.projectId.startsWith('path:')))
  const cardA = project.topics.find(topic => topic.topicId === topicA.topic.topicId)
  const cardB = project.topics.find(topic => topic.topicId === topicB.topic.topicId)
  assert.ok(cardA && cardB, 'both topic cards are on the board')
  assert.equal(cardA.counts.total, 1)
  assert.equal(cardA.tickets.length, 1)
  assert.equal(cardA.tickets[0].ticketId, t1.ticketId)
  assert.equal(cardB.counts.total, 3)
  assert.deepEqual(cardB.counts, { total: 3, open: 2, working: 0, blocked: 0, done: 1 })
  assert.deepEqual(cardB.tickets.map(ticket => ticket.ticketId).sort(), [t2.ticketId, t4.ticketId].sort())
  assert.equal(cardB.done, 1)
  assert.equal(cardB.brief, '「collect references」已完成 · 待执行 2 · 已完成 1')
  assert.equal(cardB.summaryAuto, true)
  assert.equal(cardA.brief, 'Updated brief')
  assert.equal(cardA.summaryAuto, false)
  const riaProject = board.projects.find(item => item.kind === 'ria')
  assert.ok(riaProject, 'Ria project exists')
  const unclassified = riaProject.topics.find(topic => topic.unclassified)
  assert.ok(unclassified, 'unclassified bucket exists')
  assert.equal(unclassified.title, '未分类')
  assert.equal(unclassified.topicId, 'unclassified:ria')
  assert.equal(unclassified.tickets[0].ticketId, t5.ticketId)
  assert.equal(unclassified.brief, '1 张待分类 · 最近：「loose idea without a topic」')
  assert.equal(unclassified.summaryAuto, true)

  const topicPage = await get('/plugins/dsh-ria/api/board/topic?topicId=' + encodeURIComponent(topicB.topic.topicId))
  assert.equal(topicPage.status, 200)
  assert.equal(topicPage.body.topic.title, 'Appendix')
  assert.equal(topicPage.body.counts.total, 3)
  assert.deepEqual(topicPage.body.edges.inside, [{ from: t3.ticketId, to: t4.ticketId }])
  assert.equal(topicPage.body.edges.outside.length, 1)
  assert.equal(topicPage.body.edges.outside[0].ticketId, t2.ticketId)
  assert.equal(topicPage.body.edges.outside[0].dependsOn, t1.ticketId)
  assert.equal(topicPage.body.edges.outside[0].topicId, topicA.topic.topicId)
  assert.equal(topicPage.body.edges.outside[0].topicTitle, 'Draft')
  assert.deepEqual(topicPage.body.tickets.map(ticket => ticket.ticketId).sort(), [t2.ticketId, t3.ticketId, t4.ticketId].sort())

  const missingTopic = await get('/plugins/dsh-ria/api/board/topic?topicId=topic_nope')
  assert.equal(missingTopic.status, 404)
  assert.equal(missingTopic.body.code, 'topic_missing')

  const unfinished = await fixture.call('ria_topic', { action: 'archive', topicId: topicB.topic.topicId })
  assert.equal(unfinished.ok, false)
  assert.equal(unfinished.code, 'topic_unfinished')
  const empty = await fixture.call('ria_topic', { action: 'create', title: 'Empty topic' })
  const archivedEmpty = await fixture.call('ria_topic', { action: 'archive', topicId: empty.topic.topicId })
  assert.equal(archivedEmpty.ok, true)
  assert.ok(archivedEmpty.topic.archivedAt > 0)

  const merged = await fixture.call('ria_topic', { action: 'merge', sourceTopicId: topicA.topic.topicId, targetTopicId: topicB.topic.topicId })
  assert.equal(merged.ok, true)
  assert.equal(merged.moved >= 1, true)
  const source = fixture.service.store.topic(topicA.topic.topicId)
  assert.equal(source.mergedInto, topicB.topic.topicId)
  assert.equal(fixture.service.store.primaryTopicFor(t1.ticketId), topicB.topic.topicId)

  const list = await fixture.call('ria_topic', { action: 'list' })
  assert.equal(list.ok, true)
  assert.equal(list.topics.some(topic => topic.topicId === topicA.topic.topicId), false)
  assert.equal(list.topics.find(topic => topic.topicId === topicB.topic.topicId).counts.total, 4)
  const all = await fixture.call('ria_topic', { action: 'list', includeArchived: true })
  assert.equal(all.topics.some(topic => topic.topicId === topicA.topic.topicId), true)
  assert.equal(all.topics.find(topic => topic.topicId === topicB.topic.topicId).counts.done, 1)
  assert.equal(all.topics.find(topic => topic.topicId === topicB.topic.topicId).counts.open, 3)
} finally {
  fixture.cleanup()
}

// A v4 file loads untouched and gets an exact .v4.bak before the first save.
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'dsh-ria-topic-legacy-'))
  const raw = JSON.stringify({
    schemaVersion: 4,
    version: 4,
    riaSessionId: 'session-ria',
    riaPreset: 'ptc',
    tickets: [],
    createdAt: 1,
    settings: {},
  }, null, 2) + '\n'
  writeFileSync(join(legacyDir, 'ria.json'), raw)
  const legacy = await createFixture({ stateDir: legacyDir })
  try {
    assert.equal(readFileSync(join(legacyDir, 'ria.json.v4.bak'), 'utf8'), raw)
    const migrated = JSON.parse(readFileSync(join(legacyDir, 'ria.json'), 'utf8'))
    assert.equal(migrated.schemaVersion, 5)
    assert.deepEqual(migrated.topics, [])
    assert.deepEqual(migrated.links, [])
    const created = await legacy.call('ria_topic', { action: 'create', title: 'Migrated topic' })
    assert.equal(created.ok, true)
    const saved = JSON.parse(readFileSync(join(legacyDir, 'ria.json'), 'utf8'))
    assert.equal(saved.schemaVersion, 5)
    assert.equal(saved.topics.length, 1)
  } finally {
    legacy.cleanup({ keepState: true })
    rmSync(legacyDir, { recursive: true, force: true })
  }
}


// The board UI is a pure layout plus a thin renderer. These assertions pin the
// narrower masonry card, the shared 160x58 ticket card, the 2D topic canvas,
// the modal-only filter, the brief fallback, and the click behavior.
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const promptText = managerPrompt('session-ria', '')
  assert.match(promptText, /ria_topic with action="update"/)
  assert.match(promptText, /at most 120 characters/)
  assert.match(promptText, /within 10 minutes/)
  assert.match(promptText, /primary topic/)
  const start = source.indexOf('/* board-layout:start */')
  const end = source.indexOf('/* topic-board:end */')
  assert.ok(start >= 0 && end > start, 'client board markers')
  const api = new Function(source.slice(start, end) + '\nreturn { boardLayout, boardCanOpenSession, topicWaterfall, topicBoardLayout, topicTicketLayout, topicCardHeight, topicSectionOmitted, topicTicketMatchesFilter, topicBriefText, topicMatchesQuery, TOPIC_CARD_WIDTH, TOPIC_CARD_GAP, TOPIC_PROJECT_GAP, TOPIC_TICKET_INSET, TOPIC_FILTERS, TOPIC_MODAL_PER_COLUMN };')()
  const card = (topicId, lastUpdatedAt, counts, extra = {}) => ({
    topicId,
    title: topicId,
    lastUpdatedAt,
    counts,
    tickets: extra.tickets || [],
    working: extra.working || [],
    brief: extra.brief || '',
  })
  const idleCounts = { total: 0, open: 0, working: 0, blocked: 0, done: 0 }
  const topics = [
    card('t1', 30, idleCounts),
    card('t2', 20, idleCounts),
    card('t3', 10, idleCounts),
    card('t4', 5, idleCounts),
  ]
  const flow = api.topicWaterfall(topics, 3)
  assert.equal(flow.columns, 3)
  assert.deepEqual(flow.topics.map(topic => topic.topicId), ['t1', 't2', 't3', 't4'])
  const p1 = flow.positions.get('t1')
  const p2 = flow.positions.get('t2')
  const p3 = flow.positions.get('t3')
  const p4 = flow.positions.get('t4')
  assert.equal(api.TOPIC_CARD_WIDTH, 200)
  assert.equal(api.TOPIC_TICKET_INSET, 4, '160px ticket leaves 20px margins inside a 200px card')
  assert.equal(api.TOPIC_MODAL_PER_COLUMN, 4)
  assert.equal(p1.column, 0)
  assert.equal(p2.column, 1)
  assert.equal(p3.column, 2)
  assert.equal(p1.y, 0)
  assert.equal(p2.y, 0)
  assert.equal(p3.y, 0)
  assert.equal(p4.column, 0, 'fourth card returns to the shortest column')
  assert.equal(p4.y, p1.height + api.TOPIC_CARD_GAP)
  assert.equal(flow.width, 200 * 3 + 14 * 2, 'three 200px cards plus two gaps')

  const short = api.topicWaterfall([card('only', 1, idleCounts)], 3)
  assert.equal(short.columns, 1, 'a one-topic project does not reserve three columns')

  const empty = card('plain', 1, idleCounts)
  const busy = card('busy', 1, { total: 9, open: 5, working: 4, blocked: 2, done: 0 })
  assert.equal(api.topicCardHeight(empty), 177)
  assert.equal(api.topicCardHeight(busy), 535)
  assert.equal(api.topicCardHeight(busy) - api.topicCardHeight(empty), 358)
  const onePending = card('one', 1, { total: 1, open: 1, working: 0, blocked: 0, done: 0 })
  assert.equal(api.topicCardHeight(onePending), 177 + 58)
  const threePending = card('three', 1, { total: 3, open: 3, working: 0, blocked: 0, done: 0 })
  assert.equal(api.topicCardHeight(threePending), 177 + 58 * 2 + 8 + 4 + 18)
  const fiveWorking = card('five', 1, { total: 5, open: 0, working: 5, blocked: 0, done: 0 })
  assert.equal(api.topicCardHeight(fiveWorking), 177 + 58 * 3 + 8 * 2 + 4 + 18)

  assert.equal(api.topicSectionOmitted(2, 2), false, 'exactly the limit is not omitted')
  assert.equal(api.topicSectionOmitted(3, 2), true, 'one over the limit is omitted')
  assert.equal(api.topicSectionOmitted(3, 3), false, 'exactly the working limit is not omitted')
  assert.equal(api.topicSectionOmitted(5, 3), true, 'more than the working limit is omitted')

  const projects = api.topicBoardLayout([
    { projectId: 'p1', title: 'P1', topics: [card('a', 2, idleCounts)] },
    { projectId: 'p2', title: 'P2', topics: [card('b', 1, idleCounts)] },
  ])
  assert.equal(projects.projects[0].x, 0)
  assert.equal(projects.projects[1].x, projects.projects[0].width + api.TOPIC_PROJECT_GAP)
  assert.equal(projects.width, projects.projects[0].width + api.TOPIC_PROJECT_GAP + projects.projects[1].width)
  assert.equal(projects.projects[0].positions.get('a').x, 18)
  assert.equal(projects.projects[0].positions.get('a').y, 48 + 18)

  const tickets = [1, 2, 3, 4, 5].map(index => ({
    ticketId: 'ticket_' + index,
    goal: 'goal ' + index,
    status: index === 1 ? 'done' : index === 2 ? 'working' : 'open',
    createdAt: index,
    dependsOn: index === 5 ? ['ticket_1'] : [],
  }))
  const canvas = api.topicTicketLayout(tickets)
  assert.equal(canvas.positions.size, 5, 'every ticket gets one node')
  assert.equal(canvas.edges.length, 1, 'one same-topic dependency edge')
  assert.equal(canvas.edges[0].from, 'ticket_1')
  assert.equal(canvas.edges[0].to, 'ticket_5')
  assert.equal(canvas.bands.length, 1, 'one lane for the whole topic')
  assert.equal(canvas.positions.get('ticket_1').column, 0)
  assert.equal(canvas.positions.get('ticket_4').column, 0, 'four tickets fill the first column')
  assert.equal(canvas.positions.get('ticket_5').column, 1, 'fifth ticket wraps to a new column')
  assert.ok(canvas.height > 58 * 2, 'canvas has two rows')

  assert.deepEqual(api.TOPIC_FILTERS.map(item => item.label), ['全部', '进行中', '卡住', '空闲'])
  assert.equal(api.topicTicketMatchesFilter({ status: 'open' }, 'all'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'working' }, 'working'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'blocked' }, 'blocked'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'done' }, 'idle'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'failed' }, 'idle'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'open' }, 'idle'), false)
  assert.equal(api.topicTicketMatchesFilter({ status: 'working' }, 'blocked'), false)

  assert.equal(api.boardCanOpenSession({ executor: 'session-worker' }), true)
  assert.equal(api.boardCanOpenSession({ executor: 'self' }), false)
  assert.equal(api.boardCanOpenSession({ executor: 'session-worker', executorMissing: true }), false)
  assert.equal(api.boardCanOpenSession({ executor: 'session-worker', executorArchived: true }), false)
  assert.equal(api.boardCanOpenSession({}), false)

  const briefed = card('briefed', 1, idleCounts, { brief: '  The written brief  ' })
  assert.equal(api.topicBriefText(briefed), 'The written brief')
  const fallback = card('fallback', 1, { total: 1, open: 1, working: 0, blocked: 0, done: 0 }, {
    tickets: [{ ticketId: 'ticket_new', goal: 'server owns the fallback', status: 'blocked', updatedAt: 9 }],
  })
  assert.equal(api.topicBriefText(fallback), '暂无工单', 'the client does not rebuild the server summary')
  assert.equal(api.topicBriefText(card('empty', 1, idleCounts)), '暂无工单')
  assert.equal(api.topicMatchesQuery(briefed, 'written brief'), true)
  assert.equal(api.topicMatchesQuery(briefed, 'missing'), false)

  const modalStart = source.indexOf('function TopicModal(props)')
  const overlayStart = source.indexOf('function TopicBoardOverlay(props)')
  const applyStart = source.indexOf('function apply(ctx)')
  assert.ok(modalStart > 0 && overlayStart > modalStart && applyStart > overlayStart, 'topic UI slices')
  const modal = source.slice(modalStart, overlayStart)
  const overlay = source.slice(overlayStart, applyStart)

  assert.equal((source.match(/React\.createElement\(TicketCard, \{/g) || []).length, 2, 'the topic card and the modal share TicketCard')
  assert.match(source, /"data-ria-topic-card": topic\.topicId,\s*"data-ria-topic-open": "1",\s*onClick: open,/, 'clicking the card opens its topic page')
  const topicCard = source.slice(source.indexOf('function TopicCard(props)'), modalStart)
  assert.match(topicCard, /"data-ria-topic-ellipsis": String\(count\)/)
  assert.match(topicCard, /onClick: openOmitted/)
  assert.match(topicCard, /function openOmitted\(event\) \{\s*event\.stopPropagation\(\);\s*open\(\);/)
  assert.match(topicCard, /ellipsisRow\(pendingOmitted, counts\.open\)/)
  assert.match(topicCard, /ellipsisRow\(workingOmitted, counts\.working\)/)
  assert.equal((topicCard.match(/"……"/g) || []).length, 1, 'one ellipsis row serves both sections')
  assert.doesNotMatch(topicCard, /还有 |data-ria-topic-more|openMore/)
  assert.match(source, /data-ria-ticket-card/)
  assert.match(source, /props\.onOpenSession\(ticket\.executor\)/)
  assert.match(source, /"↗ 在 " \+ \(edge\.topicTitle \|\| "未分类"\)/)
  assert.match(source, /"等拍板"/)
  assert.doesNotMatch(source, /TopicTicketRow|TOPIC_ROW_HEIGHT|data-ria-topic-ticket|compact: true/)
  assert.doesNotMatch(source, /data-ria-topic-expand/)

  assert.match(modal, /TOPIC_FILTERS\.map\(function \(item\)/)
  assert.match(modal, /data-ria-topic-filter/)
  assert.match(modal, /muted: !topicTicketMatchesFilter\(ticket, filter\)/)
  assert.match(modal, /layout\.edges\.map\(function \(edge\)/)
  assert.match(modal, /onOpenTopic: function \(edge\)/)
  assert.match(modal, /topicTicketLayout\(tickets\)/)
  assert.match(modal, /width: "min\(1120px, 94vw\)"/)
  assert.match(overlay, /placeholder: "搜索主题、简报或工单"/)
  assert.doesNotMatch(overlay, /TOPIC_FILTERS\.map|setFilter|topicFilterMatches|dimmed/)
}

console.log('topic-board ok')
