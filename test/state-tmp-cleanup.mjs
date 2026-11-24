import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { STATE_TMP_MAX_AGE_MS } from '../lib/shared/fs.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-state-tmp-cleanup-'))
try {
  const stale = join(dir, 'state.json.tmp-123-stale')
  writeFileSync(stale, 'crash leftover')
  const old = new Date(Date.now() - STATE_TMP_MAX_AGE_MS - 1000)
  utimesSync(stale, old, old)
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ chatSessionId: 'session-chat' }))
  const fixture = await createFixture({ stateDir: dir })
  try {
    assert.equal(existsSync(stale), false, 'startup removed the stale state tmp')
    assert.equal(existsSync(join(dir, 'state.json')), true)
    const events = fixture.service.routerEvents.query({ limit: 200 }).events
    const cleanup = events.filter(event => event.event === 'state.tmp_cleanup')
    assert.equal(cleanup.length, 1)
    assert.equal(cleanup[0].payload.count, 1)
    assert.deepEqual(cleanup[0].payload.files, ['state.json.tmp-123-stale'])
  } finally { fixture.cleanup() }
  console.log('state tmp startup cleanup ok')
} finally { rmSync(dir, { recursive: true, force: true }) }
