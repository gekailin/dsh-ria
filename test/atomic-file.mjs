import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeAtomic } from '../lib/state/atomic-file.mjs'

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
  assert.deepEqual(order.slice(-3), ['fsync', 'close', 'rename'])
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
  console.log('atomic file replacement and failure safety ok')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
