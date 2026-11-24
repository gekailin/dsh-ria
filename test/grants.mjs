import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { GrantService } from '../lib/grants.mjs'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-grants-'))
const grants = []
const tickets = [{ ticketId: 'task-1', goal: 'work', executor: 'session-w', status: 'working' }]
const store = {
  riaSessionId: 'session-ria',
  grants: () => grants,
  grant: grantId => grants.find(item => item.grantId === grantId),
  addGrant(grant) { grants.push(grant); return grant },
  updateGrant(grantId, patch) {
    const grant = store.grant(grantId)
    if (!grant) return undefined
    Object.assign(grant, patch)
    return grant
  },
  removeGrant(grantId) {
    const index = grants.findIndex(item => item.grantId === grantId)
    if (index >= 0) grants.splice(index, 1)
  },
  ticket: ticketId => tickets.find(item => item.ticketId === ticketId),
}

const permissions = {
  sandboxMode: 'workspace-write',
  sandboxOverride: undefined,
  approvalPolicy: 'ask',
  approvalOverride: undefined,
  available: true,
}
const executor = {
  id: 'session-w',
  session: {
    append(type, data) {
      if (type === 'sandbox/mode') permissions.sandboxOverride = data.mode
      return { seq: 1, time: 1 }
    },
  },
}
const ctx = {
  sessionController: {
    async resolveAgent(sessionId) {
      if (!permissions.available) return { error: { code: 'session/not-found', message: 'not found' } }
      assert.equal(sessionId, 'session-w')
      return { agent: executor }
    },
  },
  sandboxPolicy: {
    resolve() { return { mode: permissions.sandboxOverride ?? permissions.sandboxMode } },
    overrideOf() { return permissions.sandboxOverride },
  },
  approval: {
    effectivePolicy() { return permissions.approvalOverride ?? permissions.approvalPolicy },
    overrideOf() { return permissions.approvalOverride },
    setPolicy(agent, policy) {
      assert.equal(agent, executor)
      permissions.approvalOverride = policy
    },
  },
}

const service = new GrantService({
  ctx,
  store,
  stateDir,
  isExecutor: async sessionId => sessionId === 'session-w',
  log() {},
})

const created = await service.set({
  sessionId: 'session-w',
  ticketId: 'task-1',
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  userConfirmed: true,
})
assert.equal(created.status, 'active')
assert.equal(created.expiresAt - created.createdAt, 30 * 60_000)
assert.equal(permissions.sandboxOverride, 'danger-full-access')
assert.equal(permissions.approvalOverride, 'never')

const expiring = store.grant(created.grantId)
expiring.expiresAt = Date.now() - 1
await service.reconcile()
assert.equal(grants.length, 0)
assert.equal(permissions.sandboxOverride, 'workspace-write')
assert.equal(permissions.approvalOverride, 'ask')

// A pure downgrade is permanent: no expiry, and closing its ticket or a
// startup reconcile must not restore it.
const narrowed = await service.set({
  sessionId: 'session-w',
  ticketId: 'task-1',
  sandboxMode: 'read-only',
  approvalPolicy: 'ask',
  userConfirmed: true,
})
assert.equal(narrowed.status, 'active')
assert.equal(narrowed.kind, 'permanent')
assert.equal(narrowed.permanent, true)
assert.equal(narrowed.expiresAt, null)
assert.equal(permissions.sandboxOverride, 'read-only')
tickets[0].status = 'done'
await service.onTicketChanged(tickets[0])
assert.equal(grants.length, 1)
await service.reconcile()
assert.equal(grants.length, 1)
assert.equal(permissions.sandboxOverride, 'read-only')
const narrowedReset = await service.restore(narrowed.grantId, 'explicit-reset')
assert.equal(narrowedReset.restored, true)
assert.equal(permissions.sandboxOverride, 'workspace-write')
tickets[0].status = 'working'

const applying = await service.set({
  sessionId: 'session-w',
  approvalPolicy: 'never',
  userConfirmed: true,
})
store.updateGrant(applying.grantId, { status: 'applying' })
await service.reconcile()
assert.equal(grants.length, 0)
assert.equal(permissions.approvalOverride, 'ask')

const drifting = await service.set({
  sessionId: 'session-w',
  sandboxMode: 'danger-full-access',
  userConfirmed: true,
})
permissions.sandboxOverride = 'read-only'
const skipped = await service.restore(drifting.grantId, 'manual-test')
assert.deepEqual(skipped.skippedFields, ['sandboxMode'])
assert.equal(permissions.sandboxOverride, 'read-only')
assert.equal(grants.length, 0)

permissions.sandboxOverride = 'workspace-write'
tickets.push({ ticketId: 'task-2', goal: 'orphan', executor: 'session-w', status: 'working' })
const orphan = await service.set({
  sessionId: 'session-w',
  ticketId: 'task-2',
  sandboxMode: 'danger-full-access',
  userConfirmed: true,
})
tickets.splice(tickets.findIndex(item => item.ticketId === 'task-2'), 1)
await service.reconcile()
assert.equal(grants.length, 0)
assert.equal(permissions.sandboxOverride, 'workspace-write')

// A mixed change with a sandbox downgrade and an approval escalation is
// temporary, but expiry must restore only the escalated approval. Restoring the
// sandbox to its previous wider mode would silently re-escalate the session.
permissions.sandboxOverride = 'danger-full-access'
permissions.approvalOverride = 'ask'
const mixed = await service.set({
  sessionId: 'session-w',
  ticketId: 'task-1',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  userConfirmed: true,
})
assert.equal(mixed.kind, 'temporary')
assert.equal(permissions.sandboxOverride, 'workspace-write')
assert.equal(permissions.approvalOverride, 'never')
store.grant(mixed.grantId).expiresAt = Date.now() - 1
await service.reconcile()
assert.equal(grants.length, 0)
assert.equal(permissions.sandboxOverride, 'workspace-write')
assert.equal(permissions.approvalOverride, 'ask')

const failing = await service.set({
  sessionId: 'session-w',
  approvalPolicy: 'never',
  userConfirmed: true,
})
permissions.available = false
const failed = await service.restore(failing.grantId, 'manual-test')
assert.match(failed.error, /not found/)
assert.equal(store.grant(failing.grantId).status, 'restore_failed')
assert.match(store.grant(failing.grantId).lastError, /not found/)
service.shutdown()

const audit = readFileSync(service.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'expired'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'startup'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'ticket-done' && item.grantId === orphan.grantId))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'manual-test' && item.skipped.includes('sandboxMode')))
assert.ok(audit.some(item => item.event === 'grant/restore_failed' && item.trigger === 'manual-test'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.grantId === mixed.grantId && item.trigger === 'expired' && item.restored.includes('approvalPolicy') && !item.restored.includes('sandboxMode')))

// Ticket-scoped grants move with an explicitly reassigned executor, without a new TTL.
{
  const states = new Map(['executor-a', 'executor-b'].map(id => [id, { sandbox: 'workspace-write', approval: 'ask' }]))
  const agents = new Map([...states].map(([id, state]) => [id, { id, session: { id,
    append(type, data) { if (type === 'sandbox/mode') state.sandbox = data.mode },
  } }]))
  const records = []
  const ticket = { ticketId: 'moving-ticket', executor: 'executor-a', status: 'working' }
  const movingStore = { riaSessionId: 'ria', grants: () => records,
    grant: id => records.find(item => item.grantId === id), ticket: id => id === ticket.ticketId ? ticket : null,
    addGrant(item) { records.push(item); return item },
    updateGrant(id, patch) { Object.assign(this.grant(id), patch); return this.grant(id) },
    removeGrant(id) { records.splice(records.findIndex(item => item.grantId === id), 1) },
  }
  const moving = new GrantService({ stateDir, store: movingStore, isExecutor: id => agents.has(id), ctx: {
    sessionController: { resolveAgent: async id => ({ agent: agents.get(id) }) },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: states.get(session.id).sandbox }), overrideOf: session => states.get(session.id).sandbox },
    approval: { effectivePolicy: session => states.get(session.id).approval, overrideOf: session => states.get(session.id).approval,
      setPolicy: (agent, value) => { states.get(agent.id).approval = value } },
  } })
  try {
    const grant = await moving.set({ ticketId: ticket.ticketId, sandboxMode: 'danger-full-access', approvalPolicy: 'never', ttlSeconds: 60, userConfirmed: true })
    assert.equal(grant.scopeKey, 'ticket:' + ticket.ticketId)
    assert.equal(grant.sessionId, 'executor-a')
    ticket.executor = 'executor-b'
    const rebound = await moving.onTicketChanged(ticket)
    assert.equal(rebound[0].grantId, grant.grantId)
    assert.equal(rebound[0].expiresAt, grant.expiresAt)
    assert.equal(rebound[0].sessionId, 'executor-b')
    assert.equal(states.get('executor-a').sandbox, 'workspace-write')
    assert.equal(states.get('executor-a').approval, 'ask')
    assert.equal(states.get('executor-b').sandbox, 'danger-full-access')
    assert.equal(states.get('executor-b').approval, 'never')
    assert.equal(moving.activeForTicket(ticket.ticketId, 'executor-b').length, 1)
    assert.equal(moving.activeForTicket('other-ticket', 'executor-b').length, 0)
    movingStore.grant(grant.grantId).expiresAt = Date.now() - 1
    await moving.reconcile()
    assert.equal(records.length, 0)
    assert.equal(states.get('executor-b').sandbox, 'workspace-write')
    assert.equal(states.get('executor-b').approval, 'ask')
    const migrationAudit = readFileSync(moving.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(migrationAudit.some(item => item.event === 'grant/moved' && item.ticketId === ticket.ticketId && item.grantId === grant.grantId))
    assert.ok(migrationAudit.some(item => item.event === 'grant/restored' && item.ticketId === ticket.ticketId && item.grantId === grant.grantId && item.trigger === 'expired'))
  } finally { moving.shutdown() }
}

rmSync(stateDir, { recursive: true, force: true })
console.log('grants ok')
