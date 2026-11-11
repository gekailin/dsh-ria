// A static, agent-scoped system-prompt section that asks a worker to double
// check a message that clearly does not fit its context. It is deliberately
// global: the text is harmless for unrelated agents, and the user can switch
// it off from Settings > Super Session.

export const DISPATCH_GUARD_SECTION_NAME = 'dsh-super-session:dispatch-guard'
export const DISPATCH_GUARD_SECTION_ORDER = 4100

export const DISPATCH_GUARD_TEXT = [
  '## 任务转交提示',
  '本会话可能收到由其他会话（Super Session）转交的任务。以下提示是通用的，不代表当前消息一定是转交任务。',
  '- 如果最新一条用户消息与本会话正在做的事明显不同，或与本会话上下文完全对不上：可能发错了会话，请先向用户确认，不要直接执行。',
  '- 如果本会话空闲、刚建立，或消息与当前任务相关：按正常任务执行，不要因为这段提示额外确认。',
].join('\n')

export class DispatchGuard {
  constructor({ ctx, enabled, log }) {
    this.ctx = ctx
    this.enabled = enabled
    this.log = typeof log === 'function' ? log : () => {}
    this.entries = new Map()
  }

  install(agent) {
    if (!agent || agent.id === undefined || !agent.ctx || !agent.ctx.systemPrompt || typeof agent.ctx.systemPrompt.section !== 'function') {
      return false
    }
    const id = String(agent.id)
    const existing = this.entries.get(id)
    if (existing && existing.agent === agent) return false
    if (existing) this.dispose(id)

    let dispose
    try {
      dispose = agent.ctx.systemPrompt.section({
        name: DISPATCH_GUARD_SECTION_NAME,
        order: DISPATCH_GUARD_SECTION_ORDER,
        interpolate: false,
        text: () => this.enabled() ? DISPATCH_GUARD_TEXT : '',
      })
    } catch (error) {
      this.log('warn', 'could not install the dispatch guard on ' + id + ': ' + String(error && error.message ? error.message : error))
      return false
    }
    this.entries.set(id, { agent, dispose })
    return true
  }

  installAll() {
    const list = this.ctx.agents && typeof this.ctx.agents.list === 'function' ? this.ctx.agents.list() : []
    let count = 0
    for (const agent of Array.isArray(list) ? list : []) {
      if (this.install(agent)) count += 1
    }
    return count
  }

  subscribe() {
    const offCreated = this.ctx.on('agent/created', ({ agent }) => { this.install(agent) })
    const offDisposed = this.ctx.on('agent/disposed', ({ agent }) => {
      if (agent && agent.id !== undefined) this.dispose(String(agent.id), agent)
    })
    return () => {
      try { offCreated() } catch { /* already removed */ }
      try { offDisposed() } catch { /* already removed */ }
    }
  }

  dispose(id, agent) {
    const entry = this.entries.get(String(id))
    if (!entry) return false
    if (agent && entry.agent !== agent) return false
    this.entries.delete(String(id))
    try {
      if (typeof entry.dispose === 'function') entry.dispose()
    } catch (error) {
      this.log('warn', 'could not dispose the dispatch guard on ' + String(id) + ': ' + String(error && error.message ? error.message : error))
    }
    return true
  }

  shutdown() {
    for (const id of [...this.entries.keys()]) this.dispose(id)
  }
}
