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
  assert.equal(project.counts.total, project.topics.reduce((sum, topic) => sum + topic.counts.total, 0), 'the project header sums every topic, including unclassified')
  const riaProject = board.projects.find(item => item.kind === 'ria')
  assert.ok(riaProject, 'Ria project exists')
  assert.equal(riaProject.counts.total, riaProject.topics.reduce((sum, topic) => sum + topic.counts.total, 0), 'the Ria project header sums its unclassified bucket')
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
  const api = new Function(source.slice(start, end) + '\nreturn { boardLayout, boardCanOpenSession, topicWaterfall, topicBoardLayout, topicTicketLayout, topicTicketTerminal, topicGridColumns, projectTicketTotal, topicCardHeight, topicSectionOmitted, topicTicketMatchesFilter, topicClockText, topicFilterOutside, topicFilterBubbleState, topicFilterScrollTop, topicBriefText, topicMatchesQuery, ticketSearchResults, ticketMatchesQuery, ticketSearchRank, TICKET_SEARCH_LIMIT, TOPIC_CARD_WIDTH, TOPIC_CARD_GAP, TOPIC_PROJECT_GAP, TOPIC_TICKET_INSET, TOPIC_MAX_COLUMNS, TOPIC_FILTERS, TOPIC_DEFAULT_FILTER, TOPIC_GRID_MAX_HEIGHT, TOPIC_GRID_GAP, TOPIC_GRID_MIN_CARD_WIDTH, TOPIC_FILTER_BUBBLE_MARGIN };')()
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
  const flow = api.topicWaterfall(topics, api.TOPIC_MAX_COLUMNS)
  assert.equal(api.TOPIC_MAX_COLUMNS, 2, 'a project never grows past two masonry columns')
  assert.equal(flow.columns, 2)
  assert.deepEqual(flow.topics.map(topic => topic.topicId), ['t1', 't2', 't3', 't4'])
  const p1 = flow.positions.get('t1')
  const p2 = flow.positions.get('t2')
  const p3 = flow.positions.get('t3')
  const p4 = flow.positions.get('t4')
  assert.equal(api.TOPIC_CARD_WIDTH, 200)
  assert.equal(api.TOPIC_TICKET_INSET, 4, '160px ticket leaves 20px margins inside a 200px card')
  assert.equal(api.TOPIC_GRID_MAX_HEIGHT, 'min(72vh, 680px)')
  assert.equal(api.TOPIC_GRID_GAP, 12)
  assert.equal(api.TOPIC_GRID_MIN_CARD_WIDTH, 240)
  assert.equal(p1.column, 0)
  assert.equal(p2.column, 1)
  assert.equal(p3.column, 0, 'third card returns to the shortest column')
  assert.equal(p1.y, 0)
  assert.equal(p2.y, 0)
  assert.equal(p3.y, p1.height + api.TOPIC_CARD_GAP)
  assert.equal(p4.column, 1)
  assert.equal(p4.y, p2.height + api.TOPIC_CARD_GAP)
  assert.equal(flow.width, 200 * 2 + 14, 'two 200px cards plus one gap')

  const short = api.topicWaterfall([card('only', 1, idleCounts)], api.TOPIC_MAX_COLUMNS)
  assert.equal(short.columns, 1, 'a one-topic project occupies a single column')

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

  const day = (date, hour, minute = 0) => new Date(2026, 10, date, hour, minute, 0).getTime()
  assert.equal(api.topicClockText(day(16, 11, 8)), '11-16 11:08')

  const layoutTickets = [
    { ticketId: 'unfinished_new', status: 'open', createdAt: day(16, 11), dependsOn: [] },
    { ticketId: 'unfinished_mid', status: 'working', createdAt: day(16, 10), dependsOn: [] },
    { ticketId: 'unfinished_old', status: 'blocked', createdAt: day(15, 9), dependsOn: [] },
    { ticketId: 'finished_new', status: 'done', createdAt: day(16, 12), dependsOn: [] },
    { ticketId: 'finished_failed', status: 'failed', createdAt: day(15, 18), dependsOn: [] },
    { ticketId: 'finished_cancelled', status: 'cancelled', createdAt: day(14, 9), dependsOn: [] },
  ]
  const layout = api.topicTicketLayout(layoutTickets)
  assert.deepEqual(layout.tickets.map(ticket => ticket.ticketId), [
    'unfinished_new', 'unfinished_mid', 'unfinished_old',
    'finished_new', 'finished_failed', 'finished_cancelled',
  ], 'unfinished always precedes terminal, even when a terminal ticket is newer')
  assert.deepEqual(layout.groups.map(group => group.key), ['unfinished', 'finished'])
  assert.deepEqual(layout.groups.map(group => group.label), ['未完成', '已完成与已结束'])
  assert.deepEqual(layout.groups.map(group => group.tickets.length), [3, 3])
  assert.equal(layout.groups[0].hint, '新的在上面')
  assert.equal(layout.positions, undefined, 'the grid does not compute column positions')
  assert.equal(layout.edges, undefined, 'the grid does not draw dependency edges')

  const sameStamp = api.topicTicketLayout([
    { ticketId: 'ticket_b', status: 'open', createdAt: 5, dependsOn: [] },
    { ticketId: 'ticket_a', status: 'open', createdAt: 5, dependsOn: [] },
  ])
  assert.deepEqual(sameStamp.tickets.map(ticket => ticket.ticketId), ['ticket_a', 'ticket_b'], 'equal createdAt falls back to ticketId')

  const dependent = api.topicTicketLayout([
    { ticketId: 'ticket_blocked', status: 'open', createdAt: 1, dependsOn: ['ticket_dependency'] },
    { ticketId: 'ticket_dependency', status: 'open', createdAt: 2, dependsOn: [] },
  ])
  assert.deepEqual(dependent.tickets.map(ticket => ticket.ticketId), ['ticket_dependency', 'ticket_blocked'], 'dependencies do not reorder the grid')

  assert.equal(api.topicTicketTerminal({ status: 'done' }), true)
  assert.equal(api.topicTicketTerminal({ status: 'cancelled' }), true)
  assert.equal(api.topicTicketTerminal({ status: 'forked' }), false)
  assert.equal(api.topicTicketTerminal({}), false)
  assert.equal(api.topicGridColumns(848), 3, 'the 920px modal fits three columns')
  assert.equal(api.topicGridColumns(1110), 3)
  assert.equal(api.topicGridColumns(600), 2, 'a narrow window falls back to two columns')
  assert.equal(api.topicGridColumns(240), 2)
  assert.equal(api.topicGridColumns(0), 3, 'an unmeasured width defaults to three columns')
  assert.equal(api.topicGridColumns(undefined), 3)

  assert.equal(api.projectTicketTotal({
    topics: [
      { counts: { total: 27 } },
      { counts: { total: 6 } },
      { title: 'unclassified', counts: { total: 98 } },
    ],
  }), 131, 'the project header sums every topic total, including the unclassified bucket')
  assert.equal(api.projectTicketTotal({}), 0, 'a project without topics counts zero tickets')
  assert.equal(api.projectTicketTotal({ counts: { total: 5 }, topics: [] }), 0, 'the header does not fall back to a stale project total')

  const topCard = { ticketId: 'top', rect: { top: -100, bottom: -42 } }
  const hiddenBottom = { ticketId: 'bottom-far', rect: { top: 700, bottom: 758 } }
  const nearBottom = { ticketId: 'bottom-near', rect: { top: 680, bottom: 738 } }
  const visible = { ticketId: 'visible', rect: { top: 100, bottom: 158 } }
  const partialTop = { ticketId: 'partial-top', rect: { top: -20, bottom: 38 } }
  const partialBottom = { ticketId: 'partial-bottom', rect: { top: 580, bottom: 638 } }
  const viewport = { top: 0, bottom: 600 }
  const outside = api.topicFilterOutside([topCard, visible, hiddenBottom, nearBottom, partialTop, partialBottom], viewport)
  assert.equal(outside.top, 1, 'only the fully hidden top card counts')
  assert.equal(outside.bottom, 2, 'both fully hidden bottom cards count')
  assert.equal(outside.topTargetId, 'top')
  assert.equal(outside.bottomTargetId, 'bottom-near', 'the nearest bottom card is the target')
  assert.equal(api.topicFilterBubbleState([topCard, visible], viewport, 'working').top, 1)
  assert.equal(api.topicFilterBubbleState([visible], viewport, 'working'), null, 'nothing hidden means no bubble')
  assert.equal(api.topicFilterBubbleState([topCard], viewport, 'all').top, 1, 'the all filter still reports hidden cards')
  assert.equal(api.TOPIC_FILTER_BUBBLE_MARGIN, 16)
  assert.equal(api.topicFilterScrollTop(topCard, viewport, 500, 'top'), 384)
  assert.equal(api.topicFilterScrollTop(nearBottom, viewport, 500, 'bottom'), 654)
  assert.equal(api.topicFilterScrollTop({ ticketId: 'above', rect: { top: -100, bottom: -42 } }, viewport, 0, 'top'), 0, 'the scroll target never goes negative')

  assert.deepEqual(api.TOPIC_FILTERS.map(item => item.label), ['未完成', '执行中', '待执行', '全部'])
  assert.equal(api.TOPIC_DEFAULT_FILTER, 'unfinished')
  for (const status of ['intake', 'open', 'working', 'blocked', 'forked']) {
    assert.equal(api.topicTicketMatchesFilter({ status }, 'unfinished'), true, status + ' is unfinished')
  }
  for (const status of ['done', 'failed', 'cancelled']) {
    assert.equal(api.topicTicketMatchesFilter({ status }, 'unfinished'), false, status + ' is terminal')
  }
  assert.equal(api.topicTicketMatchesFilter({ status: 'working' }, 'working'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'open' }, 'working'), false)
  assert.equal(api.topicTicketMatchesFilter({ status: 'intake' }, 'pending'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'open' }, 'pending'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'blocked' }, 'pending'), false)
  assert.equal(api.topicTicketMatchesFilter({ status: 'working' }, 'pending'), false)
  assert.equal(api.topicTicketMatchesFilter({ status: 'done' }, 'all'), true)
  assert.equal(api.topicTicketMatchesFilter({ status: 'cancelled' }, 'all'), true)

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

  // The flat index reaches completed tickets, unclassified tickets, and the
  // seventh ticket that a topic card never renders.
  const searchIndex = [
    {
      ticketId: 'ticket_done',
      goal: 'ship the appendix',
      status: 'done',
      updatedAt: 30,
      topicId: 'topic_a',
      topicTitle: 'Draft',
      topicBrief: 'First topic',
      projectTitle: 'dsh-ria',
      executor: 'session-worker',
      executorTitle: 'Worker One',
      dependsOn: [],
      checklist: [],
    },
    {
      ticketId: 'ticket_working',
      goal: 'edit the draft',
      status: 'working',
      updatedAt: 20,
      topicId: 'topic_a',
      topicTitle: 'Draft',
      topicBrief: 'First topic',
      projectTitle: 'dsh-ria',
      executor: 'session-worker',
      executorTitle: 'Worker One',
      dependsOn: [],
      checklist: [],
    },
    {
      ticketId: 'ticket_seventh',
      goal: 'collect the seventh reference',
      status: 'open',
      updatedAt: 10,
      topicId: 'topic_a',
      topicTitle: 'Draft',
      topicBrief: 'First topic',
      projectTitle: 'dsh-ria',
      executor: 'self',
      executorTitle: 'Ria',
      dependsOn: [],
      checklist: [],
    },
    {
      ticketId: 'ticket_loose',
      goal: 'loose idea without a topic',
      status: 'blocked',
      updatedAt: 40,
      topicId: 'unclassified:ria',
      topicTitle: '未分类',
      topicBrief: '',
      projectTitle: 'Ria',
      executor: 'self',
      executorTitle: 'Ria',
      dependsOn: [],
      checklist: [],
    },
  ]
  assert.equal(api.TICKET_SEARCH_LIMIT, 40)
  assert.deepEqual(api.ticketSearchResults(searchIndex, '  '), [], 'empty query never lists every ticket')
  assert.equal(api.ticketMatchesQuery(searchIndex[0], ''), false)
  assert.deepEqual(api.ticketSearchResults(searchIndex, '  SHIP  ').map(ticket => ticket.ticketId), ['ticket_done'], 'trim and case-insensitive')
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'draft appendix').map(ticket => ticket.ticketId), ['ticket_done'], 'all terms must match')
  assert.deepEqual(api.ticketSearchResults(searchIndex, '待执行').map(ticket => ticket.ticketId), ['ticket_seventh'], 'status word matches')
  assert.deepEqual(api.ticketSearchResults(searchIndex, '进行中').map(ticket => ticket.ticketId), ['ticket_working'], 'working alias matches')
  assert.deepEqual(api.ticketSearchResults(searchIndex, '未分类').map(ticket => ticket.ticketId), ['ticket_loose'], 'unclassified topic is searchable')
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'first topic').map(ticket => ticket.ticketId), ['ticket_working', 'ticket_seventh', 'ticket_done'], 'topic brief matches every linked ticket')
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'worker one').map(ticket => ticket.ticketId), ['ticket_working', 'ticket_done'], 'executor title matches')
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'ticket_seventh').map(ticket => ticket.ticketId), ['ticket_seventh'], 'ticket id matches')
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'zzz'), [])
  assert.deepEqual(api.ticketSearchResults(searchIndex, 'draft').map(ticket => ticket.ticketId), ['ticket_working', 'ticket_seventh', 'ticket_done'], 'active tickets rank before done, then by updatedAt')
  assert.equal(api.ticketSearchRank({ status: 'working' }), 0)
  assert.equal(api.ticketSearchRank({ status: 'blocked' }), 1)
  assert.equal(api.ticketSearchRank({ status: 'done' }), 6)

  const modalStart = source.indexOf('function TopicModal(props)')
  const overlayStart = source.indexOf('function TopicBoardOverlay(props)')
  const applyStart = source.indexOf('function apply(ctx)')
  assert.ok(modalStart > 0 && overlayStart > modalStart && applyStart > overlayStart, 'topic UI slices')
  const modal = source.slice(modalStart, overlayStart)
  const overlay = source.slice(overlayStart, applyStart)

  assert.equal((source.match(/React\.createElement\(TicketCard, \{/g) || []).length, 1, 'the topic card keeps the compact TicketCard')
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
  assert.ok(source.includes("projectTicketTotal(project)"), "the project header renders the topic sum, not a stale project total")

  assert.match(modal, /TOPIC_FILTERS\.map\(function \(item\)/)
  assert.match(modal, /data-ria-topic-filter/)
  assert.match(modal, /muted: !topicTicketMatchesFilter\(ticket, filter\)/)
  assert.match(modal, /topicTicketLayout\(tickets\)/)
  assert.match(modal, /timeline\.groups\.map\(function \(group, groupIndex\)/)
  assert.match(modal, /TopicTicketSectionHeader/)
  assert.match(modal, /TopicGridTicketCard/)
  assert.match(modal, /topicGridColumns\(gridWidth\)/)
  assert.match(modal, /"data-ria-ticket-grid": group\.key/)
  assert.match(modal, /gridTemplateColumns: "repeat\(" \+ gridColumns/)
  assert.doesNotMatch(modal, /isLast/)
  assert.match(modal, /insideDeps: insideFor\(ticket\.ticketId\)/)
  assert.match(modal, /onRevealTicket: revealTicket/)
  assert.match(modal, /"data-ria-topic-scroll": topicId/)
  assert.match(modal, /maxHeight: TOPIC_GRID_MAX_HEIGHT/)
  assert.match(modal, /gridWidth/)
  assert.match(source, /new ResizeObserver\(measureWidth\)/)
  assert.doesNotMatch(modal, /layout\.edges|layout\.positions|layout\.bands|markerId|data-ria-topic-band/)
  assert.match(modal, /ref: scrollRef/)
  assert.match(modal, /data-ria-filter-bubble/)
  assert.doesNotMatch(modal, /filter === "all" \|\| !filterBubbles/)
  assert.match(modal, /revealFiltered\(direction\)/)
  assert.match(modal, /behavior: "smooth"/)
  assert.match(modal, /highlighted: highlightId === ticket\.ticketId/)
  assert.match(modal, /filterBubbleNode\("top", filterBubbles && filterBubbles\.top\)/)
  assert.match(modal, /filterBubbleNode\("bottom", filterBubbles && filterBubbles\.bottom\)/)
  assert.match(modal, /pointerEvents: "auto"/)
  assert.match(modal, /width: "min\(920px, 94vw\)"/)
  assert.match(source, /"data-ria-ticket-dependency"/)
  assert.match(source, /topicClockText\(ticket\.createdAt \|\| ticket\.updatedAt\)/)
  assert.match(source, /"data-ria-ticket-section": group\.key/)
  assert.match(source, /"未完成在前，按创建时间从新到旧/)
  assert.doesNotMatch(source, /data-ria-timeline-day|TOPIC_TIMELINE_|topicTimelineGroups|topicDayKey|TopicTimelineDayHeader/)
  assert.match(overlay, /placeholder: "搜索主题、简报或工单"/)
  assert.match(overlay, /ref: searchRef/)
  assert.match(overlay, /"aria-label": "搜索工单或主题"/)
  assert.match(overlay, /ticketSearchResults\(board && board\.searchIndex, query\)/)
  assert.match(overlay, /ticketResultsPanel\(\)/)
  assert.match(overlay, /data-ria-ticket-results/)
  assert.match(overlay, /data-ria-ticket-result": ticket\.ticketId/)
  assert.match(overlay, /data-ria-ticket-more/)
  assert.match(overlay, /"没有匹配的工单。"/)
  assert.match(overlay, /event\.key !== "\/"/)
  assert.match(overlay, /setQuery\(""\)/)
  assert.match(overlay, /searchRef\.current\.focus\(\)/)
  assert.match(overlay, /setDetailTicket\(ticket\)/)
  assert.match(overlay, /TicketDetailDialog, \{/)
  assert.match(source, /function TicketDetailDialog\(props\)/)
  assert.match(source, /"data-ria-ticket-detail": ticket\.ticketId/)
  assert.match(source, /"打开主题"/)
  assert.match(overlay, /setResultLimit\(TICKET_SEARCH_LIMIT\)/)
  assert.doesNotMatch(overlay, /TOPIC_FILTERS\.map|setFilter|topicFilterMatches|dimmed/)
}

console.log('topic-board ok')
