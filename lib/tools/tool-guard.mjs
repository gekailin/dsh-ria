import { ApprovalCoordinator } from '../core/approval-coordinator.mjs'

// Tool-permission guard moved verbatim from controller.mjs.

// Executor is the execution end of the responsibility chain and must not
// delegate. Deny the whole family (spawn/fork, list, message, interrupt), not
// only `subagent`; agent-team names are included for profiles that mount them
// and are intersected with the tools this agent actually exposes below.
const EXECUTOR_DENIED_DELEGATION_TOOLS = [
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'spawn_teammate',
  'wait_agent',
]

// The only tools a Sage session may see. They are registered in the agent's
// own scope by install(); every inherited global/preset tool is masked with
// restrict({ allow: [] }) because dsh-tools rejects scope-local names in a
// restrict() filter (it only knows inherited global tools).
const SAGE_TOOLS = ['ria_sage_read', 'ria_sage_write', 'ria_sage_decide', 'ria_sage_request', 'ria_sage_topic', 'sage_read', 'sage_write', 'sage_decide', 'sage_request', 'sage_topic']

export class ToolGuard extends ApprovalCoordinator {
  /**
   * A Executor must execute the ticket itself, not delegate it. Deny the whole
   * delegation family (spawn/fork plus list/send/interrupt), not just
   * `subagent`: a profile that mounts only some of them must still lose every
   * one it does mount. This is deliberately a deny-list, not an allow-list:
   * the PTC transport run_code cannot be named in restrict(), and the Executor
   * needs the rest of the execution tools. The mask is intersected with the
   * tools this agent actually exposes because dsh-tools rejects unknown global
   * tool names.
   */
  restrictExecutor(agent) {
    const tools = agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.restrict !== 'function' || typeof tools.view !== 'function') return
    let known
    try {
      const view = tools.view(agent)
      known = view && view.restrictableNames
    } catch {
      return
    }
    if (!known || typeof known.has !== 'function') return false
    const deny = EXECUTOR_DENIED_DELEGATION_TOOLS.filter(name => known.has(name))
    // A profile with no delegation tools needs no restriction at all.
    if (!deny.length) return true
    try {
      tools.restrict({ deny })
      return true
    } catch {
      // A profile that cannot apply this restriction still has the prompt
      // contract; do not fail Executor creation over it.
      return false
    }
  }

  /**
   * Keep only the read-only investigation tools. A profile may not mount every
   * search tool, and dsh-tools rejects a restriction that names an unknown
   * global tool, so intersect the mask with the tools this agent can see.
   */
  restrictToReadOnly(agent, label = 'Advisor') {
    const tools = agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.restrict !== 'function') {
      throw new Error(label + ' cannot be restricted to read-only tools')
    }
    let allow = ['read', 'grep', 'glob']
    try {
      // tools.view() without a scope is the deployment-global view; the PTC
      // preset mounts its tools on the preset scope, so that view looks empty.
      // Pass the agent to see exactly the set restrict() will validate against.
      const view = typeof tools.view === 'function' ? tools.view(agent) : null
      const known = view && view.restrictableNames
      if (known && typeof known.has === 'function') {
        // An empty set means the preset has not mounted its tools yet, not that
        // the profile is missing them. Defer instead of failing the Advisor.
        if (known.size === 0) return false
        allow = allow.filter(name => known.has(name))
        if (allow.length === 0) {
          this.log('warn', 'profile exposes none of read/grep/glob; Advisor stays unrestricted')
          return false
        }
      }
    } catch (error) {
      // A view() without the restrictable set is not fatal; try the full mask.
      this.log('warn', 'could not inspect Advisor tools: ' + String(error && error.message ? error.message : error))
    }
    try {
      tools.restrict({ allow })
      return true
    } catch (error) {
      this.log('warn', 'could not restrict Advisor tools: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  /**
   * Keep exactly SAGE_TOOLS visible on a Sage session.
   *
   * dsh-tools' restrict() validates every name against the INHERITED
   * (global/preset) tool set: `restrictableNames` never contains a tool
   * registered in the agent's own scope (dsh-tools/lib/index.js:453-467,
   * 489-500). Passing 'ria_sage_read'/'ria_sage_write'/'ria_sage_request' therefore throws
   * `tools.restrict() names unknown global tool ...`, and the old helper caught
   * that error and returned false, leaving Sage with every global tool.
   *
   * An empty allow-list names nothing, so it cannot throw that error; it masks
   * all inherited tools while the agent's own scoped registrations stay
   * visible (the same mechanism the Chat and reflection Executor use). A
   * failure here is not swallowed: install() rolls the scoped tools back and
   * Sage creation fails, which is safer than an unrestricted Sage.
   */
  restrictSage(agent) {
    const tools = agent && agent.ctx && agent.ctx.tools
    if (!tools || typeof tools.restrict !== 'function') {
      throw new Error('Sage cannot be restricted to its own tools')
    }
    tools.restrict({ allow: [] })
    // Fail closed if a preset ever registers a tool on the agent scope itself:
    // own-scope registrations are exempt from restrictions, so an extra name
    // is a real leak rather than a masking failure. A verification failure is
    // fatal too; this helper never returns true on an unverified surface.
    if (typeof tools.view === 'function') {
      let view
      try {
        view = tools.view(agent)
      } catch (error) {
        throw new Error('Sage tool surface could not be verified: ' + String(error && error.message ? error.message : error))
      }
      const visible = view && view.visible instanceof Map ? view.visible : null
      if (visible) {
        const leaked = [...visible.keys()].filter(name => !SAGE_TOOLS.includes(name))
        if (leaked.length > 0) {
          throw new Error('Sage tool surface is not restricted; unexpected tools: ' + leaked.sort().join(', '))
        }
      }
    }
    return true
  }
}
