import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-state-cleanup-'))
try {
  const dir = join(root, 'state')
  writeFileSync(join(dir + '.tmp'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    advisors: { global: { scope: 'global', sessionId: 'session-old' } },
    thinkers: { global: { scope: 'global', sessionId: 'session-thinker' } },
    sagePromptText: 'old prompt text',
    sageSessionId: 'session-sage',
  }, null, 2) + '\n')
  const store = new StateStore(dir)
  assert.equal(typeof store.advisor, 'undefined')
  assert.equal('advisors' in store.data, false)
  assert.equal('thinkers' in store.data, false)
  assert.equal('sagePromptText' in store.data, false)
  store.save()
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  for (const key of ['advisors', 'thinkers', 'sagePromptText']) assert.equal(key in saved, false)
  assert.equal(saved.sageSessionId, 'session-sage')
  console.log('state legacy cleanup ok')
} finally { rmSync(root, { recursive: true, force: true }) }
