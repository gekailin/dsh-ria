import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-thinkers-compat-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    thinkers: { global: { scope: 'global', sessionId: 'session-old', cwd: '/tmp/ria-thinkers', createdAt: 1 } },
    advisors: { global: { scope: 'global', sessionId: 'session-old' } },
    meta: { workerSeq: 0, reflectionSeq: 0 },
  }, null, 2) + '\n')
  const store = new StateStore(stateDir)
  assert.equal(typeof store.advisor, 'undefined')
  assert.equal('thinkers' in store.data, false)
  assert.equal('advisors' in store.data, false)
  store.save()
  const saved = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  assert.equal('thinkers' in saved, false)
  assert.equal('advisors' in saved, false)
  console.log('thinkers compat ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
