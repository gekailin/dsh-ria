import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture()

function request(method, path, payload) {
  const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
  assert.ok(route, 'API route registered')
  const req = new EventEmitter()
  req.method = method
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
  setImmediate(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

try {
  const root = await fixture.call('ria_topic', { action: 'create', title: 'Roadmap', brief: 'Top level work', level: 1 })
  const child = await fixture.call('ria_topic', {
    action: 'create',
    title: 'Design',
    brief: 'Second level work',
    level: 2,
    parentId: root.topic.topicId,
  })
  const createsBefore = fixture.creates.length

  const first = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: root.topic.topicId,
    goal: '  Ship the board composer  ',
    acceptance: 'Create a ticket from the board',
    checklist: ['draft the form', ' ', 'test the endpoint'],
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.ok, true)
  const firstTicket = first.body.ticket
  assert.equal(firstTicket.status, 'open')
  assert.equal(firstTicket.waitingOn, 'ria')
  assert.equal(firstTicket.executor, 'self')
  assert.equal(firstTicket.goal, 'Ship the board composer')
  assert.equal(firstTicket.acceptance, 'Create a ticket from the board')
  assert.deepEqual(firstTicket.checklist.map(item => item.text), ['draft the form', 'test the endpoint'])
  assert.equal(firstTicket.topicId, root.topic.topicId)
  assert.equal(firstTicket.primaryTopicId, root.topic.topicId)
  assert.equal(firstTicket.topicTitle, 'Roadmap')

  const stored = fixture.service.store.ticket(firstTicket.ticketId)
  assert.ok(stored)
  assert.equal(stored.executor, 'self')
  assert.equal(stored.waitingOn, 'ria')
  assert.equal(stored.attempt.count, 0)
  assert.equal(stored.origin.kind, 'board')
  assert.equal(fixture.service.store.deliveries().length, 0, 'creating a board ticket must not dispatch')
  assert.equal(fixture.creates.length, createsBefore, 'creating a board ticket must not create a worker')
  assert.equal(fixture.service.store.tickets().some(ticket => ticket.status === 'working'), false)

  const rootLinks = fixture.service.store.topicLinks(root.topic.topicId)
  assert.equal(rootLinks.find(link => link.ticketId === firstTicket.ticketId).role, 'primary')

  const second = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: child.topic.topicId,
    goal: 'Design the empty state',
  })
  assert.equal(second.status, 200)
  const secondTicket = second.body.ticket
  assert.equal(secondTicket.topicId, child.topic.topicId)
  const childLinks = fixture.service.store.topicLinks(child.topic.topicId)
  assert.equal(childLinks.find(link => link.ticketId === secondTicket.ticketId).role, 'primary')
  const parentLinks = fixture.service.store.topicLinks(root.topic.topicId)
  assert.equal(parentLinks.find(link => link.ticketId === secondTicket.ticketId).role, 'related')

  const status = await fixture.call('ria_status', {})
  assert.equal(status.scope, 'tickets')
  const statusTicket = status.tickets.find(ticket => ticket.ticketId === firstTicket.ticketId)
  assert.equal(statusTicket.status, 'open')
  assert.equal(statusTicket.waitingOn, 'ria')
  assert.equal(statusTicket.executor, 'self')
  const childStatusTicket = status.tickets.find(ticket => ticket.ticketId === secondTicket.ticketId)
  assert.equal(childStatusTicket.primaryTopicId, child.topic.topicId)

  const board = await fixture.service.boardData({ limit: 200 })
  const boardTicket = board.searchIndex.find(item => item.ticketId === secondTicket.ticketId)
  assert.ok(boardTicket, 'new ticket is in the search index')
  assert.equal(boardTicket.topicId, child.topic.topicId)
  assert.equal(boardTicket.primaryTopicId, child.topic.topicId)
  assert.equal(boardTicket.topicTitle, 'Design')
  assert.ok(boardTicket.projectTitle, 'the board projection carries a project title')
  const card = board.projects.flatMap(project => project.topics).find(topic => topic.topicId === child.topic.topicId)
  assert.equal(card.counts.open, 1)
  assert.ok(card.tickets.some(ticket => ticket.ticketId === secondTicket.ticketId))

  // The outbox notice is the only Ria-side signal, and it must target Ria
  // rather than a worker session.
  await fixture.service.pumpOutbox('board-compose-test')
  const notice = fixture.prompts.find(prompt => prompt.sessionId === fixture.service.store.riaSessionId &&
    JSON.stringify(prompt.content).includes('[Board ticket]'))
  assert.ok(notice, 'ticket_created notice is delivered to Ria')
  const noticeText = JSON.stringify(notice.content)
  assert.match(noticeText, new RegExp(firstTicket.ticketId))
  assert.match(noticeText, /只创建、未派发/)
  assert.match(noticeText, /不要为了这张票额外唤醒 worker/)
  assert.equal(fixture.creates.length, createsBefore)

  const missingTopic = await request('POST', '/plugins/dsh-ria/api/board/ticket', { topicId: 'topic_missing', goal: 'x' })
  assert.equal(missingTopic.status, 404)
  assert.equal(missingTopic.body.code, 'topic_missing')

  const missingGoal = await request('POST', '/plugins/dsh-ria/api/board/ticket', { topicId: root.topic.topicId, goal: '   ' })
  assert.equal(missingGoal.status, 400)
  assert.equal(missingGoal.body.code, 'goal_required')

  const badChecklist = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: root.topic.topicId,
    goal: 'bad checklist',
    checklist: ['ok', 3],
  })
  assert.equal(badChecklist.status, 400)
  assert.equal(badChecklist.body.code, 'checklist_invalid')

  const longItem = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: root.topic.topicId,
    goal: 'long item',
    checklist: ['x'.repeat(201)],
  })
  assert.equal(longItem.status, 400)
  assert.equal(longItem.body.code, 'checklist_invalid')

  const tooMany = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: root.topic.topicId,
    goal: 'too many',
    checklist: Array.from({ length: 51 }, (_, index) => 'step ' + index),
  })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.body.code, 'checklist_invalid')

  const unclassified = await request('POST', '/plugins/dsh-ria/api/board/ticket', {
    topicId: 'unclassified:inbox',
    goal: 'not on the bucket',
  })
  assert.equal(unclassified.status, 400)
  assert.equal(unclassified.body.code, 'topic_unclassified')

  const afterErrors = fixture.service.store.tickets().filter(ticket =>
    ticket.ticketId !== firstTicket.ticketId && ticket.ticketId !== secondTicket.ticketId)
  assert.equal(afterErrors.length, 0, 'rejected creates do not leave tickets behind')

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /data-ria-topic-compose/)
  assert.match(source, /data-ria-topic-compose-button/)
  assert.match(source, /data-ria-compose-goal/)
  assert.match(source, /data-ria-ticket-created/)
  assert.match(source, /function insertBoardTicket/)
  assert.match(source, /function TicketComposeDialog/)
  assert.match(source, /insertTopicModalTicket/)
  assert.match(source, /parseTicketComposeChecklist/)
  console.log('board-compose ok')
} finally {
  fixture.cleanup()
}
