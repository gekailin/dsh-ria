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
const worker = {
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
      return { agent: worker }
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
      assert.equal(agent, worker)
      permissions.approvalOverride = policy
    },
  },
}

const service = new GrantService({
  ctx,
  store,
  stateDir,
  isWorker: async sessionId => sessionId === 'session-w',
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

const audit = readFileSync(join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'expired'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'startup'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'ticket-done' && item.grantId === orphan.grantId))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'manual-test' && item.skipped.includes('sandboxMode')))
assert.ok(audit.some(item => item.event === 'grant/restore_failed' && item.trigger === 'manual-test'))

rmSync(stateDir, { recursive: true, force: true })
console.log('grants ok')
