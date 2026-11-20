import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/** Publish a complete file in its own directory. Short writes are retried;
 * before rename the old target is untouched, and failed staging is removed.
 * fsync covers the file bytes; atomic rename is not a multi-file transaction.
 * The io seam is for deterministic fault injection, never a sandbox bypass.
 */
export function writeAtomic(file, value, { mode = 0o600, io = fs, beforeRename = null } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  io.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  let fd
  let published = false
  try {
    fd = io.openSync(temp, 'wx', mode)
    let offset = 0
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!Number.isSafeInteger(written) || written <= 0) throw new Error('Atomic file write made no progress: ' + file)
      offset += written
    }
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    if (beforeRename) beforeRename()
    io.renameSync(temp, file)
    published = true
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch { /* preserve original error */ } }
    if (!published) { try { io.unlinkSync(temp) } catch { /* staging may never have opened */ } }
  }
}
