import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'ria-voice-migration-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'state.json')
  writeFileSync(join(stateDir, 'ria.json'), '{}\n')
  writeFileSync(file, JSON.stringify({ settings: { cognition: { voice: 'legacy voice' }, style: { enabled: false, preset: 'warm', custom: '' } } }) + '\n')
  const store = new RiaStore(stateDir)
  const first = store.migrateCognitionVoice()
  assert.deepEqual(first, { changed: true, moved: true })
  assert.equal(store.data.settings.cognition, undefined)
  const saved = JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8'))
  assert.equal(saved.settings.cognition, undefined)
  assert.equal(saved.settings.style.enabled, true)
  assert.equal(saved.settings.style.custom, 'legacy voice')
  assert.deepEqual(store.migrateCognitionVoice(), { changed: false, moved: false })

  writeFileSync(file, JSON.stringify({ settings: { cognition: { voice: 'old' }, style: { enabled: true, preset: 'warm', custom: 'keep' } } }) + '\n')
  const secondStore = new RiaStore(stateDir)
  assert.deepEqual(secondStore.migrateCognitionVoice(), { changed: true, moved: false })
  const kept = JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8'))
  assert.equal(kept.settings.style.custom, 'keep')
  assert.equal(kept.settings.cognition, undefined)
  console.log('voice migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }
