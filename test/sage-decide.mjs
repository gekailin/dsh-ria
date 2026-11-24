import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { CognitionStore } from '../lib/roles/cognition.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const fixture = await createFixture({ stateDefault: true })
let store
try {
  const controller = fixture.service.controller
  const sage = (await controller.ensureSage()).sessionId
  const dbPath = join(fixture.stateDir, 'cognition-tool.sqlite')
  const db = openDatabase(dbPath, { create: true })
  try {
    const insert = db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const source = JSON.stringify([{ type: 'file', ref: 'lib/roles/cognition.mjs' }])
    insert.run('prop_accept', 'executor', 'test', 'add', 'project:dsh-ria', 'Accepted cognition body', 'Accepted cause', source, 'normal', 'pending', 1)
    insert.run('prop_invalid', 'executor', 'test', 'add', 'global', 'Invalid body', '', '[]', 'normal', 'pending', 1)
    insert.run('prop_merge', 'executor', 'test', 'add', 'global', 'Merge body', 'Merge cause', source, 'normal', 'pending', 1)
    insert.run('prop_legacy', 'executor', 'test', 'add', 'global', 'Legacy body', 'Legacy cause', source, 'normal', 'denied', 1)
    insert.run('prop_inbox', 'executor', 'test', 'add', 'global', 'Inbox body', 'Inbox cause', source, 'normal', 'pending', 1)
    insert.run('prop_db_fail', 'executor', 'test', 'add', 'global', 'force-db-fail', 'force-db-fail', source, 'normal', 'pending', 1)
    insert.run('prop_no_evidence', 'executor', 'test', 'add', 'global', 'No evidence body', 'No evidence cause', '[]', 'normal', 'pending', 1)
    db.exec("CREATE TRIGGER cognition_fail_test BEFORE INSERT ON cognition_entries WHEN NEW.body='force-db-fail' BEGIN SELECT RAISE(ABORT, 'forced cognition entry failure'); END")
  } finally { db.close() }

  const audits = []
  store = new CognitionStore({
    stateDir: fixture.stateDir, backend: 'sqlite', dbPath,
    log: (level, message) => { if (level === 'warn') audits.push({ level, message }) },
    audit: event => audits.push(event),
  })
  controller.cognition = store

  const accepted = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_accept', decision: 'accepted', rationale: 'validated' })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.proposal.status, 'accepted')
  assert.equal(accepted.proposal.decidedBy, 'sage')
  assert.ok(accepted.entry && /^cog_\d+$/.test(accepted.entry.id))
  assert.equal(store.getEntry(accepted.entry.id).body, 'Accepted cognition body')
  assert.equal(accepted.receipt.proposalId, 'prop_accept')
  assert.equal(accepted.receipt.decision, 'accepted')
  assert.equal(accepted.receipt.decidedBy, 'sage')
  assert.equal(accepted.receipt.rationale, 'validated')
  assert.equal(accepted.receipt.evidenceRefs.length, 1)
  assert.deepEqual(accepted.receipt.affectedEntries, [accepted.entry.id])
  assert.deepEqual(store.getReceipt('prop_accept'), accepted.receipt)
  assert.ok(audits.some(event => event.event === 'cognition.receipt.written' && event.proposalId === 'prop_accept'))
  assert.ok(audits.some(event => event.event === 'cognition.proposal.decided' && event.proposalId === 'prop_accept'))
  const acceptedAgain = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_accept', decision: 'accepted', rationale: 'again' })
  assert.equal(acceptedAgain.ok, true)
  assert.equal(acceptedAgain.idempotent, true)
  assert.equal(acceptedAgain.proposal.decidedAt, accepted.proposal.decidedAt)
  assert.deepEqual(acceptedAgain.receipt, accepted.receipt, 'idempotent decision returns the same receipt')
  assert.equal(store.searchEntries({ scope: 'project:dsh-ria' }).length, 1, 'no duplicate entry on idempotent decision')
  const conflict = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_accept', decision: 'rejected', rationale: 'changed' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'proposal_conflict')

  const invalid = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_invalid', decision: 'accepted', rationale: 'should roll back' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'cognition_invalid')
  assert.equal(store.getProposal('prop_invalid').status, 'pending', 'invalid auto-upsert rolls proposal back')
  assert.equal(store.searchEntries({}).length, 1, 'invalid auto-upsert writes no entry')
  const dbFailedDecision = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_db_fail', decision: 'accepted', rationale: 'force db failure' })
  assert.equal(dbFailedDecision.ok, false)
  assert.equal(dbFailedDecision.code, 'cognition_backend_error')
  assert.equal(store.getProposal('prop_db_fail').status, 'pending', 'DB failure rolls proposal state back')
  assert.equal(store.searchEntries({ text: 'force-db-fail' }).length, 0, 'DB failure leaves no entry')

  const missingTarget = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_merge', decision: 'merged', rationale: 'merge', targetEntryId: 'cog_missing' })
  assert.equal(missingTarget.ok, false)
  assert.equal(missingTarget.code, 'proposal_target_missing')
  const merged = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_merge', decision: 'merged', rationale: 'merge', targetEntryId: accepted.entry.id })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(merged.proposal.status, 'merged')
  assert.equal(merged.proposal.targetEntryId, accepted.entry.id)

  const noEvidence = await fixture.callAs(sage, 'ria_sage_decide', { proposalId: 'prop_no_evidence', decision: 'rejected', rationale: 'insufficient evidence' })
  assert.equal(noEvidence.ok, true, JSON.stringify(noEvidence))
  assert.deepEqual(noEvidence.receipt.evidenceRefs, [])
  assert.equal(store.getReceipt('prop_no_evidence').decision, 'rejected')
  assert.equal(audits.some(item => item.level === 'warn' && item.message.includes('has no evidenceRefs')), true)

  const firstMigration = store.migrateProposalStatuses()
  assert.deepEqual(firstMigration.ids, ['prop_legacy'])
  assert.equal(audits.filter(event => event.event === 'cognition.status.migrated').length, 1)
  const secondMigration = store.migrateProposalStatuses()
  assert.equal(secondMigration.migrated, 0)
  assert.equal(audits.filter(event => event.event === 'cognition.status.migrated').length, 1)
  assert.equal(store.getProposal('prop_legacy').status, 'rejected')

  // Sage read/write take the DB path when backend=sqlite.
  const byId = await fixture.callAs(sage, 'ria_sage_read', { id: accepted.entry.id })
  assert.equal(byId.ok, true, JSON.stringify(byId))
  assert.equal(byId.backend, 'sqlite')
  assert.equal(byId.entry.body, 'Accepted cognition body')
  const byScope = await fixture.callAs(sage, 'ria_sage_read', { scope: 'project:dsh-ria' })
  assert.equal(byScope.backend, 'sqlite')
  assert.ok(byScope.entries.some(item => item.id === accepted.entry.id))
  const inbox = await fixture.callAs(sage, 'ria_sage_read', { inbox: true })
  assert.ok(inbox.proposals.some(item => item.id === 'prop_inbox'))
  const written = await fixture.callAs(sage, 'ria_sage_write', {
    entry: { scope: 'project:dsh-ria', body: 'DB write body', cause: 'DB write cause', sources: [{ type: 'file', ref: 'test' }] }, reason: 'tool',
  })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.backend, 'sqlite')
  assert.equal(store.getEntry(written.entry.id).body, 'DB write body')
  const invalidWrite = await fixture.callAs(sage, 'ria_sage_write', {
    entry: { scope: 'project:dsh-ria', body: 'missing cause', cause: '', sources: [] }, reason: 'invalid',
  })
  assert.equal(invalidWrite.code, 'cognition_invalid')

  // DB unavailable: read falls back to files; write warns and falls back to file.
  store.db.close()
  const fallback = new CognitionStore({ stateDir: fixture.stateDir, backend: 'sqlite', dbPath: join(fixture.stateDir, 'missing.sqlite'), log: (level, message) => { if (level === 'warn') audits.push({ level, message }) } })
  controller.cognition = fallback
  const fallbackRead = await fixture.callAs(sage, 'ria_sage_read', { path: 'INDEX.md' })
  assert.equal(fallbackRead.ok, true)
  assert.equal(typeof fallbackRead.content, 'string')
  const fallbackWrite = await fixture.callAs(sage, 'ria_sage_write', {
    entry: { scope: 'global', body: 'fallback body', cause: 'fallback cause', sources: [{ type: 'file', ref: 'test' }] },
    path: 'chat/fallback.md', content: 'fallback file', reason: 'fallback',
  })
  assert.equal(fallbackWrite.ok, true, JSON.stringify(fallbackWrite))
  assert.equal(fallbackWrite.path, 'chat/fallback.md')
  assert.equal(readFileSync(join(fixture.stateDir, 'cognition', 'chat', 'fallback.md'), 'utf8'), 'fallback file')
  assert.equal(audits.some(item => item.level === 'warn' && item.message.includes('sqlite unavailable')), true)
  console.log('sage decide and DB tools ok')
} finally {
  try { store.db.close() } catch { /* already closed */ }
  fixture.cleanup()
}
