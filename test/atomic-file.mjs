import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeAtomic } from '../lib/state/atomic-file.mjs'
import { cleanupStaleStateTemps, STATE_TMP_MAX_AGE_MS } from '../lib/shared/fs.mjs'

const dir = fs.mkdtempSync(join(tmpdir(), 'ria-atomic-file-'))
try {
  const target = join(dir, 'nested', 'state.json')
  writeAtomic(target, 'old-complete')
  const order = []
  const io = {
    ...fs,
    writeSync(fd, bytes, offset, length, position) {
      order.push('write')
      return fs.writeSync(fd, bytes, offset, Math.min(length, 3), position)
    },
    fsyncSync(fd) { order.push('fsync'); fs.fsyncSync(fd) },
    closeSync(fd) { order.push('close'); fs.closeSync(fd) },
    renameSync(from, to) {
      order.push('rename')
      assert.equal(fs.readFileSync(to, 'utf8'), 'old-complete')
      assert.equal(fs.readFileSync(from, 'utf8'), '新内容🙂complete')
      fs.renameSync(from, to)
    },
  }
  writeAtomic(target, '新内容🙂complete', { io })
  assert.equal(fs.readFileSync(target, 'utf8'), '新内容🙂complete')
  assert.ok(order.filter(item => item === 'write').length > 1, 'short writes retried')
  assert.deepEqual(order.slice(-5), ['fsync', 'close', 'rename', 'fsync', 'close'])
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(join(dir, 'nested')), ['state.json'])

  for (const fail of ['write', 'fsync', 'rename', 'no-progress']) {
    writeAtomic(target, 'old-complete')
    const bad = { ...fs }
    if (fail === 'write') bad.writeSync = () => { throw new Error('write failed') }
    if (fail === 'fsync') bad.fsyncSync = () => { throw new Error('fsync failed') }
    if (fail === 'rename') bad.renameSync = () => { throw new Error('rename failed') }
    if (fail === 'no-progress') bad.writeSync = () => 0
    assert.throws(() => writeAtomic(target, 'never-published', { io: bad }), /failed|no progress/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'old-complete')
    assert.deepEqual(fs.readdirSync(join(dir, 'nested')), ['state.json'], 'failed temporary files removed')
  }
  writeAtomic(target, Buffer.from([0, 255, 10]))
  assert.deepEqual(fs.readFileSync(target), Buffer.from([0, 255, 10]))
  writeAtomic(target, '')
  assert.equal(fs.statSync(target).size, 0)

  // Concurrency: microtask-parallel writers must not cross-contaminate; the
  // last scheduled complete write wins and no staging file remains.
  await Promise.all(Array.from({ length: 4 }, (_, index) => Promise.resolve().then(() => writeAtomic(target, 'concurrent-' + index))))
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent-3')
  assert.equal(fs.readdirSync(join(dir, 'nested')).some(name => name.includes('.tmp-')), false)

  // Crash leftovers: only stale state.json tmp files are removed; current and
  // unrelated files stay intact.
  {
    const stateDir = join(dir, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    const stateFile = join(stateDir, 'state.json')
    fs.writeFileSync(stateFile, 'current-state')
    const oldA = join(stateDir, 'state.json.tmp-999-stale')
    const oldB = join(stateDir, 'state.json.888.legacy.tmp')
    const fresh = join(stateDir, 'state.json.tmp-777-fresh')
    fs.writeFileSync(oldA, 'stale-a')
    fs.writeFileSync(oldB, 'stale-b')
    fs.writeFileSync(fresh, 'fresh')
    const old = new Date(Date.now() - STATE_TMP_MAX_AGE_MS - 1000)
    fs.utimesSync(oldA, old, old)
    fs.utimesSync(oldB, old, old)
    const cleaned = cleanupStaleStateTemps(stateDir)
    assert.deepEqual(cleaned.removed.map(item => item.name).sort(), ['state.json.888.legacy.tmp', 'state.json.tmp-999-stale'])
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'current-state')
    assert.equal(fs.existsSync(fresh), true)
  }

  console.log('atomic file replacement and failure safety ok')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }