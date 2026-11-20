import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { V2Store } from '../lib/v2/store.mjs'
import { advisorPrompt, chatPrompt, ticketBrief, workerPrompt } from '../lib/v2/prompts.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// The role used to be called "thinker"; these tests keep the upgrade path honest.
// Legacy literals below are deliberate fixtures, not live code.

const dir = mkdtempSync(join(tmpdir(), 'ria-advisor-migration-'))
try {
  // ① An old v2.json that only has the legacy field is read as advisors.
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({
    schemaVersion: 1,
    chatbotSessionId: null,
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
  // The stored cwd is kept verbatim: the directory was not renamed on disk.
  assert.equal(store.advisor('global').cwd, '/tmp/ria-thinkers')
  // Legacy ticket metadata phase is normalized on load.
  assert.equal(store.data.tickets.ticket_legacy.phase, 'advisor')

  // ② The first write migrates the field: advisors only, legacy key gone.
  store.setAdvisor('global', 'session-new')
  const migrated = JSON.parse(readFileSync(join(dir, 'v2.json'), 'utf8'))
  assert.equal(migrated.advisors.global.sessionId, 'session-new')
  assert.equal('thinkers' in migrated, false)

  // ③ A ticket written before the rename is loaded as an advisor ticket and the
  //    next save writes the new role name.
  const ria = new RiaStore(dir)
  const created = ria.addTicket({ status: 'open', waitingOn: 'ria', executor: 'thinker', goal: 'legacy role ticket', acceptance: 'x' })
  created.executor = 'thinker'
  created.history.push({ at: Date.now(), from: 'intake', to: 'open', actor: 'thinker' })
  ria.save()
  const reloaded = new RiaStore(dir)
  assert.equal(reloaded.ticket(created.ticketId).executor, 'advisor')
  assert.equal(reloaded.ticket(created.ticketId).history.at(-1).actor, 'advisor')

  // ④ The Advisor tool surface works on that legacy ticket, and a normal write
  //    persists the migrated role.
  const fixture = await createFixture({ v2Default: true, stateDir: dir })
  try {
    await fixture.service.ensure()
    const ensured = await fixture.service.v2.ensureAdvisor('global')
    const advisorId = ensured && ensured.sessionId ? ensured.sessionId : fixture.service.v2.v2.advisor('global').sessionId
    const plan = await fixture.callAs(advisorId, 'ticket_plan', { ticketId: created.ticketId, summary: 'legacy plan', steps: ['do it'] })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    fixture.service.store.save()
    const raw = readFileSync(join(dir, 'ria.json'), 'utf8')
    assert.equal(raw.includes('"executor": "thinker"'), false)
    assert.equal(JSON.parse(raw).tickets.find(item => item.ticketId === created.ticketId).executor, 'advisor')
  } finally {
    fixture.cleanup()
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ⑤ The prompts carry the new role name and never the old one.
assert.match(advisorPrompt(), /^你是 Advisor（参谋）/)
assert.match(advisorPrompt(), /plan of record/)
assert.match(advisorPrompt(), /没有 WorkOrder 的工单不得进入 working/)
assert.match(chatPrompt(), /Advisor（参谋）/)
assert.doesNotMatch(chatPrompt(), /Thinker/)
assert.doesNotMatch(workerPrompt({}), /Thinker/)
assert.match(workerPrompt({}), /只对 Ria\/Advisor 负责/)
assert.match(ticketBrief({ ticketId: 't', goal: 'g' }, {}, {}), /阶段: advisor/)

console.log('v2 advisor migration ok')
