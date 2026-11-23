import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSageContext } from '../lib/reflection-sage-context.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-sage-context-'))
try {
  const state = join(root, 'state'); const cog = join(state, 'cognition'); mkdirSync(join(cog, 'chat'), { recursive: true }); mkdirSync(join(cog, 'proposals'), { recursive: true })
  writeFileSync(join(cog, 'principles.md'), '# Principles\n\n## 2026-11-20 old\nold rule\n\n## 2026-11-23 new\nnew rule\n')
  writeFileSync(join(cog, 'chat', 'decisions.md'), '# Decisions\n\n## 2026-11-22 decision\nkeep this\n')
  writeFileSync(join(cog, 'proposals', 'p1.json'), JSON.stringify({ id: 'p1', text: 'pending proposal', scope: 'global', status: 'pending', createdAt: Date.parse('2026-11-23T01:00:00Z') }))
  writeFileSync(join(cog, 'proposals', 'p2.json'), JSON.stringify({ id: 'p2', text: 'accepted proposal', scope: 'global', status: 'accepted', createdAt: Date.parse('2026-11-22T01:00:00Z'), reviewedAt: Date.parse('2026-11-23T02:00:00Z') }))
  writeFileSync(join(cog, 'proposals', 'p3.json'), JSON.stringify({ id: 'p3', text: 'rejected proposal', scope: 'global', status: 'rejected', createdAt: Date.parse('2026-11-21T01:00:00Z'), reviewedAt: Date.parse('2026-11-21T02:00:00Z') }))
  const events = [{ type: 'turn/start', time: 1 }, { type: 'assistant/message', time: 2 }, { type: 'tool/result', time: 3 }, { type: 'approval/request', time: 4 }]
  const full = readSageContext(state, { since: '2026-11-22T00:00:00Z', maxChars: 20000, events, sageSessionId: 'sage-1', now: Date.parse('2026-11-23T12:00:00Z') })
  assert.ok(full.cognitionSnapshot && full.pendingProposals && full.decisionHistory && full.sageActivity)
  assert.equal(full.pendingProposals.items.length, 1)
  assert.equal(full.pendingProposals.items[0].id, 'p1')
  assert.equal(full.decisionHistory.items.length, 1)
  assert.equal(full.decisionHistory.items[0].id, 'p2')
  assert.equal(full.decisionHistory.items[0].decidedBy, null)
  assert.equal(full.sageActivity.counts.turns, 1)
  assert.equal(full.counts.pendingProposals, 1)
  assert.equal(full.truncated, false)
  assert.ok(full.cognitionSnapshot.files.some(file => file.file === 'principles.md' && file.items.some(item => item.anchor.includes('2026-11-23'))))
  // since excludes the 2026-11-20 entry.
  assert.equal(full.cognitionSnapshot.files.find(file => file.file === 'principles.md').items.length, 1)
  const tiny = readSageContext(state, { since: '2026-11-22T00:00:00Z', maxChars: 80, events, sageSessionId: 'sage-1' })
  assert.equal(tiny.truncated, true)
  const empty = readSageContext(join(root, 'empty'), { since: 0, maxChars: 20000 })
  assert.equal(empty.counts.files, 0)
  assert.equal(empty.pendingProposals.items.length, 0)
  assert.equal(empty.decisionHistory.recorded, '无记录')
  assert.equal(empty.truncated, false)
  console.log('reflection sage context ok')
} finally { rmSync(root, { recursive: true, force: true }) }
