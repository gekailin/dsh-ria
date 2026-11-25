// Process-local keyed mutex used to serialize work on one Ticket or Executor.
//
// A lock is an in-memory async chain: callers with the same key run one at a
// time in arrival order, while different keys stay independent. It is not a
// queue and holds no state: once the last task releases, the key disappears.
// This is the mechanism half of the ticketLock -> executorLock ordering; it
// never survives a restart and never schedules background work.

export class KeyedLock {
  constructor() {
    this.tails = new Map()
  }

  async run(key, task) {
    const id = String(key == null ? '' : key)
    if (!id) return await task()
    const previous = this.tails.get(id) || Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    this.tails.set(id, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this.tails.get(id) === tail) this.tails.delete(id)
    }
  }

  /** True while a task is queued/running for this key (diagnostics only). */
  active(key) {
    return this.tails.has(String(key == null ? '' : key))
  }
}
