// Canonical role tool names. Keep this list in sync with ToolRegistry
// registrations; WorkOrder validation uses it to flag stale/unknown names.
export const RIA_TOOL_NAMES = Object.freeze([
  'ria_chat_request', 'ria_chat_status', 'ria_chat_executor_config', 'ria_chat_session_config', 'ria_chat_co_manage', 'ria_chat_forward',
  'ria_chat_models', 'ria_chat_steer', 'ria_chat_stop_ticket', 'ria_chat_resume',
  'ria_chat_sessions', 'ria_chat_send_image', 'ria_chat_read',
  'ria_chat_grant', 'ria_chat_watch', 'ria_chat_new_session', 'ria_chat_propose', 'ria_chat_reflect',
  'ria_ticket_read', 'ria_ticket_plan', 'ria_ticket_dispatch', 'ria_ticket_block',
  'ria_sage_read', 'ria_sage_write', 'ria_sage_decide', 'ria_sage_request', 'ria_sage_topic',
  'ria_executor_report',
  'ria_session_list', 'ria_session_events',
  'ria_reflect_status', 'ria_reflect_read_tickets', 'ria_reflect_read_sessions',
  'ria_reflect_read_session', 'ria_reflect_read_context', 'ria_reflect_read_role_context', 'ria_reflect_read_sage_context', 'ria_reflect_report',
])

export const RIA_TOOL_NAME_SET = new Set(RIA_TOOL_NAMES)

// Registered deprecated aliases. They stay callable for one release but are not
// canonical WorkOrder tokens, so plans should cite the executor names above.
export const DEPRECATED_RIA_TOOL_NAMES = Object.freeze([
  'ria_chat_worker_config', 'ria_worker_report', 'worker_report',
])

// Tool-like tokens in WorkOrder text. Deliberately narrow: only role tools and
// the known legacy names, so error codes such as ticket_missing are not flagged.
const TOOL_TOKEN = /\b(?:ria_[a-z0-9_]+|worker_report|chatbot_[a-z0-9_]+|chat_[a-z0-9_]+|ticket_plan|ticket_dispatch|ticket_block|ticket_read|sage_read|sage_write|sage_request|sage_topicsession_list|session_events)\b/g

export function candidateWorkOrderTools(value) {
  const text = Array.isArray(value) ? value.join('\n') : String(value == null ? '' : value)
  return [...new Set(text.match(TOOL_TOKEN) || [])]
}

export function unknownWorkOrderTools(value) {
  return candidateWorkOrderTools(value).filter(name => !RIA_TOOL_NAME_SET.has(name))
}
