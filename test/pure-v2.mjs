// Pure v2 guarantees: the legacy manager, the tasks.log compatibility path,
// the Advisor mode switch and the cognition/chatbot directory are gone.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { V2Store } from '../lib/v2/store.mjs'
import { advisorPrompt, chatPrompt, ticketBrief, workerPrompt } from '../lib/v2/prompts.mjs'
import { createFixture } from './support/ria-fixture.mjs'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')

// --- legacy state is still readable where storage cannot be rewritten ----
const dir = mkdtempSync(join(tmpdir(), 'ria-pure-v2-'))
try {
  // An old v2.json that only has the creator field is read as advisors.
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({
    schemaVersion: 1,
    chatSessionId: null,
    thinkers: { global: { scope: 'global', sessionId: 'session-old', cwd: '/tmp/ria-thinkers', createdAt: 1 } },
    workers: {},
    requests: {},
    tickets: { ticket_legacy: { ticketId: 'ticket_legacy', phase: 'thinker' } },
    workOrders: {},
    reports: [],
    inbox: [],
    lastError: null,
  }, null, 2))
  const store = new V2Store(dir)
  assert.equal(store.advisor('global').sessionId, 'session-old')
  assert.equal(store.advisor('global').cwd, '/tmp/ria-thinkers')
  assert.equal(store.data.tickets.ticket_legacy.phase, 'advisor')

  // The first write migrates the field: advisors only, legacy key gone.
  store.setAdvisor('global', 'session-new')
  const migrated = JSON.parse(readFileSync(join(dir, 'v2.json'), 'utf8'))
  assert.equal(migrated.advisors.global.sessionId, 'session-new')
  assert.equal('thinkers' in migrated, false)

  // A ticket written before the rename is loaded with the canonical role.
  const ria = new RiaStore(dir)
  const created = ria.addTicket({ status: 'open', waitingOn: 'ria', executor: 'thinker', goal: 'legacy role ticket', acceptance: 'x' })
  created.executor = 'thinker'
  created.history.push({ at: Date.now(), from: 'intake', to: 'open', actor: 'thinker' })
  ria.save()
  const reloaded = new RiaStore(dir)
  assert.equal(reloaded.ticket(created.ticketId).executor, 'advisor')
  assert.equal(reloaded.ticket(created.ticketId).history.at(-1).actor, 'advisor')

  // The stateless Advisor plans the legacy ticket without creating a session.
  const fixture = await createFixture({ v2Default: true, stateDir: dir, advisorPlan: 'stateless', llmReply: JSON.stringify({ action: 'plan', workOrder: { summary: 'legacy plan', steps: ['do it'] } }) })
  try {
    await fixture.service.ensure()
    const chatbot = fixture.service.v2.v2.chatSessionId
    const planned = await fixture.callAs(chatbot, 'chatbot_request', { goal: 'legacy role ticket' })
    assert.equal(planned.ok, true, JSON.stringify(planned))
    assert.equal(planned.stateless, true)
    fixture.service.store.save()
    const raw = readFileSync(join(dir, 'ria.json'), 'utf8')
    assert.equal(raw.includes('"executor": "thinker"'), false)
  } finally {
    fixture.cleanup()
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --- prompts carry the new role name and never the old one --------------
assert.match(advisorPrompt(), /^你是 Advisor（参谋）/)
assert.match(advisorPrompt(), /plan of record/)
assert.match(advisorPrompt(), /没有 WorkOrder 的工单不得进入 working/)
assert.match(chatPrompt(), /Advisor（参谋）/)
assert.doesNotMatch(chatPrompt(), /Thinker/)
assert.doesNotMatch(workerPrompt({}), /Thinker/)
assert.match(workerPrompt({}), /只对 Ria\/Advisor 负责/)
assert.match(ticketBrief({ ticketId: 't', goal: 'g' }, {}, {}), /阶段: advisor/)

// --- the removed surfaces stay removed ----------------------------------
const index = read('../lib/index.js')
for (const name of ['toolTicket', 'toolResolve', 'toolSpawn', 'toolModel', 'toolTitle', 'toolStatus', 'toolRequest', 'toolSendFile', 'toolRead', 'toolQueue', 'toolTopic', 'toolApproval', 'toolApprovalDecision', 'toolGrant', 'toolMemory']) {
  assert.equal(index.includes('async ' + name + '('), false, name + ' must be gone')
}
assert.equal(index.includes('tasks.log'), false, 'tasks.log compatibility path must be gone')
assert.equal(index.includes('LEGACY_TICKET_LOG'), false)
assert.equal(index.includes('ria_send_file'), false)
const roles = read('../lib/v2/roles.mjs')
assert.equal(roles.includes('LEGACY_ROLE_CHAT'), false)
assert.equal(roles.includes('normalizeRole'), false)
const controller = read('../lib/v2/controller.mjs')
for (const gone of ['ensureAdvisor', 'retireLegacyAdvisor', 'sage.migrated', 'advisorMode', 'chatbotSessionId']) {
  assert.equal(controller.includes(gone), false, gone + ' must be gone from the controller')
}
assert.equal(controller.includes("roleSessionTitle('chatbot')"), false)
const storeSource = read('../lib/v2/store.mjs')
assert.equal(storeSource.includes('advisorMode'), false)
assert.equal(storeSource.includes('setAdvisorMode'), false)
assert.equal(storeSource.includes('chatbotSessionId'), false)
assert.ok(storeSource.includes('chatSessionId'))
const cognition = read('../lib/v2/cognition.mjs')
assert.equal(cognition.includes('chatbot'), false)
assert.ok(cognition.includes('chatDigest'))
assert.equal(index.includes('cognition/chatbot'), false)

console.log('pure v2 ok')
