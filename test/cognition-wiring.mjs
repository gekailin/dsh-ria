import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { CognitionStore, normalizeProposalAuthor } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store
  const stateDir = fixture.stateDir
  const workspace = join(stateDir, 'workspace', 'dsh-ria')
  mkdirSync(workspace, { recursive: true })
  const dbPath = join(stateDir, 'wiring.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    const insert = db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)')
    for (let index = 1; index <= 4; index += 1) insert.run('p' + index, 'Project ' + index, JSON.stringify([workspace]), 'overview ' + index, 'active', index)
  } finally { db.close() }
  controller.cognition = new CognitionStore({ stateDir, dbPath })

  // Voice and project overview are appended without changing the memory block.
  store.setSettings({ cognition: { voice: 'X'.repeat(600) } })
  const prompt = controller.chatSystemPrompt('BASE PROMPT', { cwd: workspace })
  assert.ok(prompt.startsWith('BASE PROMPT'))
  assert.ok(prompt.includes('[说话风格]'))
  assert.ok((prompt.match(/X/g) || []).length <= 500, 'voice capped at 500 chars')
  assert.ok(prompt.includes('[活跃项目概况]'))
  assert.ok(prompt.includes('Project 1') && prompt.includes('Project 2') && prompt.includes('Project 3'))
  assert.ok(prompt.includes('Project 4'), 'all active project summaries (max 10)')
  assert.ok(prompt.includes('[长期记忆摘要]'))
  assert.ok(prompt.indexOf('[说话风格]') < prompt.indexOf('[活跃项目概况]'))
  assert.ok(prompt.indexOf('[活跃项目概况]') < prompt.indexOf('[长期记忆摘要]'))

  // Author normalization and old-record compatibility.
  assert.equal(normalizeProposalAuthor('reflection'), 'reflection')
  assert.equal(normalizeProposalAuthor('executor:session-x'), 'executor:session-x')
  assert.equal(normalizeProposalAuthor('sage'), 'sage')
  assert.equal(normalizeProposalAuthor('user'), 'user')
  assert.equal(normalizeProposalAuthor('executor:'), 'reflection')
  assert.equal(normalizeProposalAuthor('bogus'), 'reflection')
  const chat = controller.state.chatSessionId
  const userProposal = await fixture.callAs(chat, 'ria_chat_propose', { text: 'User preference' })
  assert.equal(userProposal.proposal.author, 'user')

  // Executor proposals derive author from the actual executor kind.
  const request = await fixture.callAs(chat, 'ria_chat_request', { goal: 'author test', acceptance: 'x' })
  assert.equal(request.ok, true, JSON.stringify(request))
  const ticket = fixture.service.tickets.ticket(request.ticketId)
  fixture.service.tickets.transitionTicket(request.ticketId, 'working', { actor: 'router', executor: 'session-author-exec', waitingOn: 'executor' })
  controller.state.addExecutor('session-author-exec', { kind: 'managed', executorType: 'work', status: 'working', currentTicketId: request.ticketId })
  const reported = await controller.executorReport({
    ticketId: request.ticketId, status: 'progress', summary: 'executor insight',
    cognitionProposal: { text: 'executor learned this' },
  }, { agent: { id: 'session-author-exec' } })
  assert.equal(reported.ok, true, JSON.stringify(reported))
  assert.equal(controller.cognition.listProposals().find(item => item.body === 'executor learned this').author, 'executor:session-author-exec')

  const reflectionRequest = await fixture.callAs(chat, 'ria_chat_request', { goal: 'reflection author', acceptance: 'x' })
  fixture.service.tickets.transitionTicket(reflectionRequest.ticketId, 'working', { actor: 'router', executor: 'session-author-reflection', waitingOn: 'executor' })
  controller.state.addExecutor('session-author-reflection', { executorType: 'reflection', status: 'working', currentTicketId: reflectionRequest.ticketId })
  const reflectionReport = await controller.executorReport({
    ticketId: reflectionRequest.ticketId, status: 'progress', summary: 'reflection insight',
    cognitionProposal: { text: 'reflection learned this' },
  }, { agent: { id: 'session-author-reflection' } })
  assert.equal(reflectionReport.ok, true, JSON.stringify(reflectionReport))
  assert.equal(controller.cognition.listProposals().find(item => item.body === 'reflection learned this').author, 'reflection')
  console.log('cognition prompt/author wiring ok')
} finally { fixture.cleanup() }
