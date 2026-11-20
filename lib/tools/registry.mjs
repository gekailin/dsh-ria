import { join } from 'node:path'
import { advisorPrompt, chatPrompt, workerPrompt } from '../core/prompts.mjs'
import { isChatRole } from '../roles/roles.mjs'
import { ESCALATION_POLICIES } from '../core/risk.mjs'
import { CHATBOT_IMAGE_LIMIT, REVIEW_EVENT_TYPES, WORKER_PRESET_WHITELIST, text } from '../core/shared.mjs'
import { ToolGuard } from './tool-guard.mjs'

// Tool registration moved verbatim from controller.mjs: same tool names, same
// registration order, same restrictions.

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: TOOL_OUTPUT,
    execute: (args, exec) => execute(args && typeof args === 'object' ? args : {}, exec),
  }
}

export class ToolRegistry extends ToolGuard {
  /**
   * Read-only retrospective tools for reflection Workers. They live here (not
   * in the Advisor branch) because reviewing past sessions is execution work:
   * it reads logs, not repository code, and never prompts, appends to, updates
   * or renames a session.
   */
  registerSessionTools(register) {
    register('session_list', 'Read-only retrospective tool: list sessions (never prompts, appends to, renames or otherwise modifies a session). Filter by id prefix, title/cwd substring, updatedAt range, running or agentAvailable. Subagent rows are excluded unless includeSubagents is true; archived rows are marked and kept unless includeArchived is false. Titles and cwd are redacted for tokens and credentials.', {
      type: 'object',
      properties: {
        idPrefix: { type: 'string', description: 'Case-insensitive session id prefix.' },
        titleContains: { type: 'string', description: 'Case-insensitive title substring.' },
        cwdContains: { type: 'string', description: 'Case-insensitive cwd substring.' },
        updatedAfter: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive lower bound on updatedAt: epoch milliseconds or an ISO 8601 string.' },
        updatedBefore: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive upper bound on updatedAt: epoch milliseconds or an ISO 8601 string.' },
        running: { type: 'boolean', description: 'Only sessions whose list row has this running value.' },
        agentAvailable: { type: 'boolean', description: 'Only sessions whose list row has this agent-availability value.' },
        includeSubagents: { type: 'boolean', description: 'Include subagent rows (origin=subagent or with a parentSessionId). Defaults to false.' },
        includeArchived: { type: 'boolean', description: 'Keep archived sessions and mark them archived. Defaults to true.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum sessions to return, 1-50. Defaults to 20.' },
      },
      additionalProperties: false,
    }, (args, exec) => this.sessionList(args, exec))
    register('session_events', 'Read-only retrospective tool: read a bounded, redacted summary of one session\'s event log (never prompts, appends to, updates, renames or otherwise modifies the session). sessionId accepts a unique prefix. Defaults to review-critical events: ' + REVIEW_EVENT_TYPES.join(', ') + ', plus any event type containing "error". Use types for exact names or prefix globs such as approval/* and turn/*. Reads backwards in bounded pages; limit caps the returned events, summaryChars caps each one-line summary, and truncated/more/nextThroughSeq continue with older events.', {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id or a unique id prefix.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Event types to keep: exact names and prefix globs like approval/*. Omit for the review-critical default set.' },
        fromSeq: { type: 'number', description: 'Inclusive lower seq bound.' },
        toSeq: { type: 'number', description: 'Inclusive upper seq bound; defaults to the current log cursor.' },
        fromTime: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive lower event time: epoch milliseconds or an ISO 8601 string.' },
        toTime: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Inclusive upper event time: epoch milliseconds or an ISO 8601 string.' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Maximum events to return, 1-200. Defaults to 50.' },
        summaryChars: { type: 'number', minimum: 1, maximum: 300, description: 'Maximum characters per one-line summary, 1-300. Defaults to 160.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    }, (args, exec) => this.sessionEvents(args, exec))
  }

  install(agent, role) {
    if (!agent || this.installed.has(agent)) return
    const sessionId = String(agent.id)
    const installedRole = this.installedRoles.get(sessionId)
    if (installedRole) {
      if (installedRole === role) {
        this.retryRestriction(agent, role)
        return
      }
      throw new Error('session ' + sessionId + ' is already installed as ' + installedRole + ', not ' + role)
    }
    const pendingDisposers = []
    const visibleTools = () => {
      try {
        // Without the agent argument this is the deployment-global view, which
        // omits preset-scope tools entirely. Ask for this agent's view so an
        // earlier install attempt's scoped registrations are detected.
        const view = agent.ctx.tools.view(agent)
        return view && view.visible instanceof Map ? view.visible : null
      } catch { return null }
    }
    const register = (name, description, parameters, execute) => {
      // A previous install attempt may have registered this role's tools and
      // failed before it could mark the session installed. Reuse the visible
      // registration instead of throwing duplicate-tool on the retry.
      const visible = visibleTools()
      if (visible && visible.has(name)) return
      const definition = defineTool(name, description, parameters, execute)
      try {
        const dispose = agent.ctx.tools.register(definition)
        if (typeof dispose === 'function') pendingDisposers.push(dispose)
      } catch (error) {
        // The visible-tools probe can fail transiently while a preset is still
        // mounting. If the registration is in fact already there, reuse it
        // instead of failing the whole session on a duplicate-name error.
        const message = String(error && error.message ? error.message : error)
        if (!/already registered/i.test(message)) throw error
        const current = visibleTools()
        if (!current || !current.has(name)) throw error
        this.log('warn', 'reusing existing tool ' + name + ' on ' + sessionId)
      }
    }
    const worker = role === 'worker' ? this.state.worker(sessionId) : null
    if (isChatRole(role)) {
      register('chatbot_request', 'Create a tracked work ticket for a user request and hand it to the Advisor. Every ticket is a work ticket: the Advisor plans it and a Worker executes it. Answer simple questions directly instead; use this when the work needs follow-up, files, code, or a durable outcome. workerId/workerSeq can pin an explicit Worker; unavailable pinned Workers block on the user and are never automatically replaced.', {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the user wants, in their own words.' },
          acceptance: { type: 'string', description: 'How completion should be judged.' },
          workspace: { type: 'string', description: 'Optional absolute path of the project directory the work targets. Only set this when the user named an existing directory.' },
          escalationPolicy: { type: 'string', enum: ESCALATION_POLICIES, description: 'Optional per-ticket policy: auto-low-medium allows medium risks (e.g. plugin install) after approval-free risk grading.' },
          workerPreset: { type: 'string', description: 'Optional preset for a newly created work Worker (default ptc). Applies only when the ticket has to create a Worker; an idle Worker is reused with its existing preset. Allowed: ' + WORKER_PRESET_WHITELIST.join(', ') + '.' },
          workerId: { type: 'string', description: 'Optional explicit managed Worker session id, work mode only. Mutually exclusive with workerSeq. May select an allowAutoDispatch=false Worker; if unavailable, the ticket blocks on the user and is never automatically reassigned.' },
          workerSeq: { type: 'integer', minimum: 1, description: 'Optional work Worker sequence number from chatbot_worker_config get; mutually exclusive with workerId. Resolves to a fixed session id for this ticket, not a later replacement.' },
          preferredTags: { type: 'array', items: { type: 'string' }, description: 'Optional capability tags the user asked for. Merged with Advisor routing tags and used for deterministic Worker affinity (dedicated protection still applies).' },
          topicId: { type: 'string', description: 'Optional existing topic id to link as this ticket primary topic (weak association; never blocks dispatch).' },
          attachImages: { type: 'boolean', description: 'Attach the current user message images to the ticket/WorkOrder; defaults true. Set false to disable.' },
        },
        required: ['goal'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotRequest(args, exec))
      register('chatbot_status', 'Read active tickets and their latest progress. Pass ticketId for one ticket.', {
        type: 'object',
        properties: { ticketId: { type: 'string' } },
        additionalProperties: false,
      }, (args) => this.chatbotStatus(args))
      register('chatbot_worker_config', 'Inspect or change managed Worker configuration. get lists Workers with seq/title/cwd/workerType/preset/model/status/allowAutoDispatch. set may change allowAutoDispatch immediately (false excludes automatic selection, but explicit ticket selection still works without bypassing safety checks), change a Worker model live (applies from the next turn), or its preset. DSH has no live preset switch: a preset change returns worker_preset_requires_recreate unless recreate=true, which stops the old binding, creates a new Worker in the same cwd/type and archives the old session. Only the Chat may call this.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'] },
          workerId: { type: 'string', description: 'Exact Worker session id. Required for set unless seq is given.' },
          seq: { type: 'number', description: 'Worker sequence number from get.' },
          preset: { type: 'string', description: 'New preset for the Worker. Requires recreate=true to take effect. Allowed: ' + WORKER_PRESET_WHITELIST.join(', ') + '.' },
          allowAutoDispatch: { type: 'boolean', description: 'Whether automatic selection may assign this Worker new tickets (default true). False requires explicit workerId/workerSeq selection; does not stop a current ticket. Applies immediately.' },
          model: { type: 'string', description: 'New model id.' },
          provider: { type: 'string', description: 'Provider for the model when the id exists under several providers.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for the model.' },
          recreate: { type: 'boolean', description: 'For preset changes: stop the old binding and create a new Worker in the same cwd/type; the old session is archived.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Explicit capability tags for affinity routing (max 12, normalized). Pass [] to clear.' },
          roleNote: { type: 'string', description: 'One-line role note shown in the worker view (max 120 characters).' },
          dedicated: { type: 'boolean', description: 'Dedicated Worker protection: when true, automatic dispatch only offers tickets whose tags intersect its tags. Explicit selection still works.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotWorkerConfig(args, exec))
      register('chatbot_co_manage', 'Register an existing ordinary session as a co-managed ticket executor (kind=co-managed), update its identity (set), list them, or remove one. A co-managed session keeps its own context/model/tools and receives only the Advisor WorkOrder, as one message starting with [WorkOrder #<ticketId>]. Automatic selection never offers it a global ticket or a ticket outside its cwd. set only changes an existing co-managed session and never creates one. Only the Chat may call it.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'set', 'remove', 'list'] },
          sessionId: { type: 'string', description: 'Exact ordinary session id from chatbot_sessions. Required for add/remove.' },
          title: { type: 'string', description: 'Optional title snapshot; defaults to the session title.' },
          cwd: { type: 'string', description: 'Optional absolute cwd override; defaults to the session cwd.' },
          allowAutoDispatch: { type: 'boolean', description: 'Whether automatic selection may assign this session tickets (default true). False requires an explicit workerId selection.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Explicit capability tags (max 12, normalized). Recommended with dedicated=true for a session the user is chatting in.' },
          roleNote: { type: 'string', description: 'One-line role note (max 120 characters).' },
          dedicated: { type: 'boolean', description: 'Dedicated protection: automatic dispatch only offers tickets whose tags intersect this session tags. Explicit selection still works.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotCoManage(args, exec))
      register('chatbot_models', 'List the models currently available in this deployment. Read-only. Reads the DSH llm registry; if it cannot be read, returns the bundled fallback catalog and marks source=bundled-fallback with the reason. Use this before chatbot_worker_config set when the exact model id is unknown.', {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'Optional exact provider id filter.' },
          query: { type: 'string', description: 'Optional case-insensitive substring over model id and display name.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum models to return. Defaults to 50.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.chatbotModels(args, exec))
      register('chatbot_steer', 'Send a direction change to the Worker of a ticket. It is delivered at the next step boundary (after the current tool call returns, before the next step starts) as one merged host message; a running tool is never interrupted mid-call. If the Worker is idle, it is delivered directly. Backlog that misses the turn is retried before done.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ticketId', 'message'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotSteer(args, exec))
      register('chatbot_stop_ticket', 'Force-stop the Worker of a ticket. Only the Chat may call it. The ticket becomes cancelled with resolution.reason, its pending steer is discarded, and the running Worker turn is aborted when DSH supports it; if it cannot be aborted, the Worker is told at its next step boundary to end with a termination note (the current tool call is never interrupted). A repeated stop is idempotent; a done ticket is rejected and keeps its status.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'Ticket to stop.' },
          reason: { type: 'string', description: 'Why the user wants it stopped; recorded in resolution.reason.' },
        },
        required: ['ticketId', 'reason'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotStopTicket(args, exec))
      register('chatbot_resume', 'Resume a ticket that is blocked on the user or on the environment. Pass the user answer or direction when there is one.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotResume(args, exec))
      register('chatbot_sessions', 'List the ordinary top-level DSH sessions the user can also open directly. Use this when the user asks to talk to, check on, or hand a message to another session. Managed Workers and Advisors are not listed; they are reached through tickets.', {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional title substring.' },
          limit: { type: 'number', description: 'Maximum sessions to return, 1-20. Defaults to 10.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.chatbotSessions(args, exec))
      register('chatbot_send_image', 'Send 1-5 local images to the current WeChat Claw reply target. Chat-only. Each path must be absolute, PNG/JPEG/WebP/GIF, at most 10MB; total at most 20MB. Uses the existing Claw encrypted CDN upload and serial image queue; returns a result for every path. No connection or paused channel is a readable error, never an implicit text-only send.', {
        type: 'object',
        properties: {
          paths: { type: 'array', minItems: 1, maxItems: CHATBOT_IMAGE_LIMIT, items: { type: 'string' }, description: 'Absolute paths of the local images to send.' },
          caption: { type: 'string', maxLength: 2000, description: 'Optional caption sent once before the first image.' },
        },
        required: ['paths'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotSendImage(args, exec))
      register('chatbot_read', 'Read recent messages from an ordinary independent session, optionally only those after a cursor returned by a previous chatbot_read. Use this to check a long-running session later.', {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string', description: 'Title text when the id is unknown; spacing and close spelling are tolerated, but ambiguity is rejected.' },
          afterSeq: { type: 'number', description: 'Only return messages with a sequence number greater than this.' },
          limit: { type: 'number', description: 'Maximum messages to read, 1-30. Defaults to 20.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.chatbotRead(args, exec))
      register('chatbot_direct', 'Turn on WeChat Claw direct mode for one ordinary independent session. While it is on, the user\'s WeChat messages go straight to that session, and its replies are forwarded to WeChat with a prefix. Use action=off to leave; direct mode is never persisted across a restart. Managed Workers and Advisors are not eligible.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['on', 'off', 'status'] },
          sessionId: { type: 'string', description: 'Exact session id from chatbot_sessions. Required for action=on unless title is given.' },
          title: { type: 'string', description: 'Title text when the id is unknown; spacing and close spelling are tolerated, but ambiguity is rejected.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotDirect(args, exec))
      register('chatbot_grant', 'DEBUG/EMERGENCY ONLY: change one top-level session\'s sandbox mode or approval policy. Normal escalation goes through per-request risk approval (low may be auto-allowed, medium only under auto-low-medium, high/unknown always ask); never use this grant to bypass an approval or a blocked ticket. Call only when the user explicitly asks for it. A pure downgrade is permanent and can be reset explicitly. Any escalation is temporary and requires a TTL. Automatic restore on expiry, bound-ticket close, or startup undoes only the escalated fields, so a downgrade bundled into the same grant stays in effect; an explicit reset undoes every requested field. Every set call is audited with grant_kind=debug|emergency. This changes session permissions only, not tools or model.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'reset'] },
          sessionId: { type: 'string', description: 'Legacy session-only target for independent sessions. A ticket target resolves its current executor instead. The Chat itself is not eligible.' },
          ticketId: { type: 'string', description: 'Primary grant scope for managed work; authorization automatically follows its current executor without extending TTL. Defaults to the Worker\'s current ticket.' },
          sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
          approvalPolicy: { type: 'string', enum: ['ask', 'never'] },
          ttlSeconds: { type: 'number', minimum: 60, maximum: 86400, description: 'Required in practice for an escalation; ignored for a pure downgrade.' },
          reason: { type: 'string', description: 'Why the user asked for this; required for set.' },
          kind: { type: 'string', enum: ['debug', 'emergency'], description: 'Why this bypass exists: debug (default) or emergency. Recorded as grant_kind in audit.jsonl.' },
          grantId: { type: 'string', description: 'Required for reset.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotGrant(args, exec))
      register('chatbot_watch', 'Watch an ordinary independent session for co-management: relay its assistant replies (with a 【协管·title】 prefix and dedupe/merge/rate limits), forward its questions and approval requests to the user, and observe user messages sent directly to that session. action=add/remove/list/status. Only the Chat may call it.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'list', 'status'] },
          sessionId: { type: 'string', description: 'Exact session id for add/remove/status.' },
          title: { type: 'string', description: 'Title when adding or resolving a session.' },
          watchId: { type: 'string', description: 'Watch id for remove/status.' },
          id: { type: 'string', description: 'Alias for watchId/sessionId in commands.' },
          all: { type: 'boolean', description: 'With action=remove, remove every watch.' },
          options: {
            type: 'object',
            properties: {
              relayReplies: { type: 'boolean' },
              relayQuestions: { type: 'boolean' },
              rateLimit: {
                type: 'object',
                properties: {
                  maxPerMin: { type: 'number', minimum: 1, maximum: 60 },
                  mergeWindowMs: { type: 'number', minimum: 0, maximum: 60000 },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotWatch(args, exec))
      register('chatbot_new_session', 'Create a new ordinary DSH session (not a Chat/Advisor/Worker role session). Use only when the user explicitly asks to create a new regular session. Requires title (<=80 chars) and an existing cwd outside Ria state, ~/.dsh and system directories. Optional standard preset and first user message. Max 5 creations per minute.', {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Session title, 1-80 characters.' },
          cwd: { type: 'string', description: 'Existing absolute directory; must not be inside Ria state, ~/.dsh or system directories.' },
          preset: { type: 'string', description: 'Optional standard preset whitelist; defaults to standard.' },
          firstMessage: { type: 'string', description: 'Optional first ordinary user message sent after creation.' },
        },
        required: ['title', 'cwd'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotNewSession(args, exec))
      register('chatbot_propose', 'Submit a user cognition proposal to Sage. Use when the user states a durable preference, agreement or decision that should be remembered. Does not write memory directly.', {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The proposed memory, concise and self-contained.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Optional supporting references.' },
          scope: { type: 'string', description: 'global or project key/workspace.' },
        },
        required: ['text'],
        additionalProperties: false,
      }, (args, exec) => this.chatbotPropose(args, exec))
    } else if (role === 'sage') {
      register('sage_read', 'Read the cognition INDEX or a cognition file under stateDir/cognition/. Defaults to INDEX; use path for principles.md, projects/<key>.md, chat/*.md, decisions.md or proposals. Read-only.', {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under cognition/, e.g. INDEX.md, principles.md, projects/dsh-ria-xxxx.md, chat/preferences.md.' },
          inbox: { type: 'boolean', description: 'List pending proposals instead of a file.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.sageRead(args, exec))
      register('sage_write', 'Write one cognition file under stateDir/cognition/. Sage is the only writer. INDEX.md and proposals/ are managed by the system and cannot be written.', {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under cognition/.' },
          content: { type: 'string' },
          mode: { type: 'string', enum: ['replace', 'append'] },
          reason: { type: 'string' },
          source: { type: 'string' },
          resolveProposal: { type: 'string', description: 'Optional proposal id to mark accepted after writing.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }, (args, exec) => this.sageWrite(args, exec))
      register('sage_request', 'Ask Router to create a reflection or work request for research. This only creates a request; Router classifies, approves and dispatches.', {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['reflection', 'work'] },
          goal: { type: 'string' },
          acceptance: { type: 'string' },
        },
        required: ['goal'],
        additionalProperties: false,
      }, (args, exec) => this.sageRequest(args, exec))
      register('sage_topic', 'Groom the two-level Project/Topic structure. Structure only: never changes ticket state, never dispatches, never stops a Worker. list shows topics with ticket progress; update edits title/brief; merge moves every link from sourceTopicId into targetTopicId and archives the source; archive is refused with topic_unfinished while the topic still has unfinished tickets.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'update', 'merge', 'archive'] },
          topicId: { type: 'string', description: 'Topic id for update/archive; also the target of merge when targetTopicId is not given.' },
          sourceTopicId: { type: 'string', description: 'merge: topic to fold into the target (its links move with it).' },
          targetTopicId: { type: 'string', description: 'merge: topic that keeps the merged links.' },
          title: { type: 'string', description: 'update: new short title.' },
          brief: { type: 'string', description: 'update: optional one-line direction brief.' },
          projectKey: { type: 'string', description: 'list: only topics of this project key.' },
          includeArchived: { type: 'boolean', description: 'list: include archived/merged topics. Defaults false.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.sageTopic(args, exec))
    } else if (role === 'advisor') {
      register('ticket_read', 'Read one ticket, its WorkOrder, recent Worker reports and manager inbox.', {
        type: 'object',
        properties: { ticketId: { type: 'string' } },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.ticketRead(args, exec))
      register('ticket_plan', 'Write the WorkOrder for a ticket. Steps must be directly executable by a Worker.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          artifacts: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
          lessons: { type: 'array', items: { type: 'string' }, description: 'Optional lesson ids to pin into the WorkOrder; the Worker brief cites them.' },
          cognitionProposal: {
            type: 'object',
            properties: {
              scope: { type: 'string' },
              text: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
            },
            required: ['text'],
            additionalProperties: false,
            description: 'Optional memory proposal for Sage; not written to cognition directly.',
          },
          escalationPolicy: { type: 'string', enum: ESCALATION_POLICIES, description: 'Per-ticket escalation policy: strict (ask for every escalation), auto-low (auto-allow low risk; default), or auto-low-medium (also auto-allow medium risk). High/unknown always ask.' },
          routing: {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' }, description: '1-4 capability tags this ticket needs.' },
              requireTagMatch: { type: 'boolean', description: 'When true, automatic dispatch only reuses Workers whose tags/autoTags intersect the ticket tags.' },
            },
            additionalProperties: false,
            description: 'Optional routing hints stored on the WorkOrder; Router merges them with the user\'s preferredTags.',
          },
        },
        required: ['ticketId', 'summary'],
        additionalProperties: false,
      }, (args, exec) => this.ticketPlan(args, exec))
      register('ticket_dispatch', 'Dispatch a planned ticket to a managed Worker. An explicit workerSessionId overrides the ticket binding; otherwise workerId/workerSeq in ticket meta wins. Without a binding, automatic selection excludes allowAutoDispatch=false Workers. An unavailable specified Worker blocks the ticket on the user without replacement. A Worker can run one ticket at a time.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          workerSessionId: { type: 'string' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      }, (args, exec) => this.ticketDispatch(args, exec))
      register('lesson_search', 'Search the lessons library for entries relevant to a ticket. Read-only. Matching runs over an inverted index of tags and tokens (scenario/pitfall/approach/condition), so it never scans the whole library.', {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Goal or keywords of the ticket.' },
          workspace: { type: 'string', description: 'Optional workspace path; its segments participate in matching.' },
          mode: { type: 'string', description: 'Optional ticket mode: work or reflection.' },
          limit: { type: 'number', minimum: 1, maximum: 5, description: 'Maximum lessons to return, 1-5. Defaults to 3.' },
        },
        additionalProperties: false,
      }, (args, exec) => this.lessonSearch(args, exec))
      register('lesson_review', 'Review lesson candidates proposed by Workers. action=list lists candidates; accept folds one into the lessons library (dedupe by normalized scenario+pitfall); reject marks it rejected. Only the Advisor may review; Workers can only propose.', {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'accept', 'reject'] },
          id: { type: 'string', description: 'Candidate id, required for accept/reject.' },
          status: { type: 'string', enum: ['candidate', 'accepted', 'rejected'], description: 'For action=list: which candidates to show. Defaults to candidate.' },
        },
        required: ['action'],
        additionalProperties: false,
      }, (args, exec) => this.lessonReview(args, exec))
      register('ticket_block', 'Park a ticket on the user because information or a decision is missing.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          reason: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['ticketId', 'reason'],
        additionalProperties: false,
      }, (args, exec) => this.ticketBlock(args, exec))
    } else if (role === 'worker') {
      register('worker_report', 'Report a milestone, blocked question, completion, or failure for the current ticket. Progress does not close the ticket; done and failed do.', {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          status: { type: 'string', enum: ['progress', 'blocked', 'done', 'failed'] },
          summary: { type: 'string', description: 'What was done, or why it is blocked/failed.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Commands run, files changed, test results, links.' },
          question: { type: 'string', description: 'For blocked: the exact question for the user.' },
          next: { type: 'string', description: 'For progress: the next milestone.' },
          lessons: {
            type: 'array',
            description: 'Optional lesson candidates (max 5). They stay inert until an Advisor accepts them with lesson_review.',
            items: {
              type: 'object',
              properties: {
                scenario: { type: 'string', description: 'The situation this lesson applies to.' },
                pitfall: { type: 'string', description: 'What went wrong or what to avoid.' },
                approach: { type: 'string', description: 'The approach that worked.' },
                evidence: { type: 'string', description: 'Optional file, command or link backing it up.' },
              },
              required: ['scenario', 'pitfall', 'approach'],
              additionalProperties: false,
            },
          },
        },
        required: ['ticketId', 'status'],
        additionalProperties: false,
      }, (args, exec) => this.workerReport(args, exec))
      // Retrospective tools belong to reflection Workers only. Ordinary work
      // Workers and the Advisor never see them.
      if (worker && worker.workerType === 'reflection') this.registerSessionTools(register)
    }
    const prompt = isChatRole(role)
      ? chatPrompt()
      : role === 'advisor'
        ? advisorPrompt()
        : role === 'sage'
          ? this.sageSystemPrompt(sessionId)
          : workerPrompt(worker || {})
    try {
      // systemPrompt.section() requires a finite order; omitting it throws after
      // the scoped tools are registered and leaves them behind on retry.
      if (agent.ctx && agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function') {
        try {
          // DSH calls a function-valued text with section.text(context) on
          // every assembly (every model step). The Chat prompt therefore
          // re-reads cognition/chat/ each time, with no event or dedupe.
          const sectionText = isChatRole(role)
            ? (context) => this.chatSystemPrompt(prompt, context)
            : () => prompt
          const dispose = agent.ctx.systemPrompt.section({
            name: 'ria-state-' + role,
            order: 60,
            interpolate: false,
            text: sectionText,
          })
          if (typeof dispose === 'function') pendingDisposers.push(dispose)
        } catch (error) {
          // Same retry case for the prompt section; any other failure is real.
          if (!/already registered/i.test(String(error && error.message ? error.message : error))) throw error
        }
      }
      if (isChatRole(role)) {
        if (!agent.ctx.tools || typeof agent.ctx.tools.restrict !== 'function') {
          throw new Error('Chat cannot be restricted to its own tools')
        }
        agent.ctx.tools.restrict({ allow: [] })
      } else if (role === 'advisor') {
        if (!this.restrictToReadOnly(agent)) this.pendingRestrictions.set(sessionId, role)
      } else if (role === 'sage') {
        this.restrictSage(agent)
      } else if (role === 'worker') {
        const kind = worker && worker.workerType === 'reflection' ? 'reflection' : 'work'
        // A reflection Worker must never hold write tools, even if its preset
        // mounts them: keep only read/grep/glob.
        const applied = kind === 'reflection'
          ? this.restrictToReadOnly(agent, 'Reflection Worker')
          : this.restrictWorker(agent)
        if (!applied) this.pendingRestrictions.set(sessionId, role)
      }
    } catch (error) {
      // Do not leave a half-installed role unstricted. Roll back the scoped
      // tools/prompt and let the caller retry or fail the session creation.
      for (const dispose of pendingDisposers.reverse()) {
        try { dispose() } catch { /* already disposed */ }
      }
      throw error
    }
    this.installed.add(agent)
    this.installedRoles.set(sessionId, role)
    for (const dispose of pendingDisposers) {
      this.disposers.push(dispose)
      this.service.disposers.push(dispose)
    }
  }

  /**
   * Apply a restriction that was queued because the preset's tools were not
   * mounted yet. Called when a session is resolved again and before its next
   * step, when the tool registry is complete.
   */
  retryRestriction(agent, role) {
    const sessionId = String(agent && agent.id)
    if (!sessionId || !this.pendingRestrictions.has(sessionId)) return
    let applied = false
    try {
      if (role === 'advisor') applied = this.restrictToReadOnly(agent)
      else if (role === 'worker') {
        const worker = this.state.worker(sessionId)
        applied = worker && worker.workerType === 'reflection'
          ? this.restrictToReadOnly(agent, 'Reflection Worker')
          : this.restrictWorker(agent)
      }
    } catch (error) {
      this.log('warn', 'could not apply ' + role + ' restriction to ' + sessionId + ': ' + String(error && error.message ? error.message : error))
      return
    }
    if (applied) this.pendingRestrictions.delete(sessionId)
  }
}
