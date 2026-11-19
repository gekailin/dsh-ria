import { AsyncLocalStorage } from 'node:async_hooks'

const scope = new AsyncLocalStorage()
const error = (code, message) => Object.assign(new Error(message), { code })

/** FIFO single writer. Jobs are deliberately synchronous, short state operations.
 * Model/session/network awaits belong before or after run(), never inside it.
 * runSync preserves the existing store API; run supplies a Promise to async callers.
 */
export class StateWriter {
  constructor({ transaction = task => task(), onError = () => {} } = {}) {
    this.transaction = transaction
    this.onError = onError
    this.queue = []
    this.running = false
    this.closed = false
    this.sequence = 0
    this.committed = 0
    this.failed = 0
  }

  get inJob() { return scope.getStore()?.writer === this && scope.getStore().active }

  assertEntry() {
    if (this.inJob) throw error('writer_reentrant', 'Cannot enqueue the same writer from its active job; defer notifications until after commit')
    if (this.closed) throw error('writer_closed', 'State writer is closed')
  }

  run(label, task) {
    this.assertEntry()
    return new Promise((resolve, reject) => {
      this.queue.push({ label, task, resolve, reject })
      this.pump()
    })
  }

  runSync(label, task) {
    this.assertEntry()
    let value, cause, finished = false
    this.queue.push({ label, task, resolve: result => { value = result; finished = true }, reject: failure => { cause = failure; finished = true } })
    this.pump()
    if (!finished) throw error('writer_busy', 'Synchronous write could not run; await writer.run instead')
    if (cause) throw cause
    return value
  }

  afterCommit(callback, key = callback) {
    const job = scope.getStore()
    if (job?.writer === this && job.active) job.effects.set(key, callback)
    else scope.run(undefined, () => this.notify(callback))
  }

  notify(callback) {
    try {
      const pending = callback()
      if (pending && typeof pending.catch === 'function') pending.catch(cause => this.onError(cause))
    } catch (cause) { this.onError(cause) }
  }

  pump() {
    if (this.running) return
    while (this.queue.length) {
      const job = this.queue.shift()
      const context = { writer: this, active: true, seq: ++this.sequence, effects: new Map() }
      let result, cause
      this.running = true
      try {
        if (job.task?.constructor?.name === 'AsyncFunction') throw error('async_transaction', 'Writer jobs must not be async; await model/session calls outside')
        result = scope.run(context, () => this.transaction(() => {
          const value = job.task()
          if (value && typeof value.then === 'function') throw error('async_transaction', 'Writer jobs cannot return a Promise')
          return value
        }))
        this.committed += 1
      } catch (failure) { cause = failure; this.failed += 1 }
      finally { context.active = false; this.running = false }
      // COMMIT has returned and the ALS transaction scope is gone. A callback
      // can safely enqueue a *new* job, e.g. markReadyNotified, without deadlock.
      if (cause) job.reject(cause)
      else {
        scope.run(undefined, () => { for (const effect of context.effects.values()) this.notify(effect) })
        job.resolve(result)
      }
    }
  }

  async drain() { if (this.running || this.queue.length) await this.run('drain', () => {}) }
  async close() { await this.drain(); this.closed = true }
  stats() { return { pending: this.queue.length, running: this.running, committed: this.committed, failed: this.failed, sequence: this.sequence } }
}
