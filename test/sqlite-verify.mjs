import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySqliteState } from '../scripts/sqlite-verify.mjs'
import { seedSqliteFromState } from './support/sqlite-seed.mjs'

const script = fileURLToPath(new URL('../scripts/sqlite-verify.mjs', import.meta.url))
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const ticket = (id, extra = {}) => ({
  ticketId: id, status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'goal ' + id,
  acceptance: 'accept', revision: 1, createdAt: 100, updatedAt: 100, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null,
  history: [{ at: 100, actor: 'router', from: 'intake', to: 'open', reason: 'route' }],
  ...extra,
})

const root = mkdtempSync(join(tmpdir(), 'ria-sqlite-verify-'))
try {
  const dir = join(root, 'state')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const hot = [ticket('t1'), ticket('t2', { status: 'working', waitingOn: 'worker' })]
  const archived = ticket('t3', { status: 'done', closedAt: 200, resolution: { summary: 'done' } })
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: hot, settings: { keep: true } }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ tickets: { t1: { ticketId: 't1', phase: 'advisor' } } }))
  writeFileSync(join(dir, 'tickets.log.jsonl'), JSON.stringify({ ticket: archived, closedAt: 200 }) + '\n')
  seedSqliteFromState({ stateDir: dir })

  const dbBefore = sha(join(dir, 'ria.sqlite'))
  const verified = verifySqliteState({ stateDir: dir })
  assert.equal(verified.ok, true)
  assert.equal(verified.mode, 'verify-only')
  assert.deepEqual(verified.counts, { tickets: 3, history: 3, hot: 2, archived: 1, meta: 1 })
  assert.equal(verified.countsMatch, true)
  assert.deepEqual(verified.integrity, ['ok'])
  assert.equal(sha(join(dir, 'ria.sqlite')), dbBefore, 'verification is read-only')

  const cli = spawnSync(process.execPath, [script, '--state-dir', dir, '--verify-only'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).ok, true)

  // A JSON/DB count mismatch is reported as unhealthy and exits non-zero.
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [hot[0]], settings: { keep: true } }))
  const mismatch = verifySqliteState({ stateDir: dir })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.countsMatch, false)
  const badCli = spawnSync(process.execPath, [script, '--state-dir', dir], { encoding: 'utf8' })
  assert.equal(badCli.status, 1)
  assert.equal(JSON.parse(badCli.stdout).ok, false)

  // Missing DB: clear error code, non-zero CLI exit.
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  writeFileSync(join(empty, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [] }))
  assert.throws(() => verifySqliteState({ stateDir: empty }), { code: 'sqlite_missing' })
  const missing = spawnSync(process.execPath, [script, '--state-dir', empty], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).code, 'sqlite_missing')

  console.log('sqlite verify ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
