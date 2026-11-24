// Request-id namespaces used to tell user messages apart.
//
// DSH records every prompt as a user/message with source { kind: 'user', rpcId }.
// Request ids are caller-minted: the Web UI and other clients use their own ids,
// WeChat inbound uses the wx_ prefix, and dsh-ria uses ria_ for prompts it
// injects itself (startup recovery, turn notices, queue wakes, reminders).
// Only a user message outside the dsh-ria namespace is a real non-WeChat
// channel message that should pause WeChat pushes.
//
// Older dsh-ria versions used host_ for the same namespace. Keep reading that
// prefix for existing session logs and queued data, but all new ids are ria_.

export const WECHAT_REQUEST_PREFIX = 'wx_'
export const RIA_REQUEST_PREFIX = 'ria_'
const LEGACY_RIA_REQUEST_PREFIX = 'host_'

export function isWechatRequestId(value) {
  return typeof value === 'string' && value.startsWith(WECHAT_REQUEST_PREFIX)
}

/** True for ids minted by dsh-ria, including legacy host_ ids. */
export function isRiaRequestId(value) {
  return typeof value === 'string'
    && (value.startsWith(RIA_REQUEST_PREFIX) || value.startsWith(LEGACY_RIA_REQUEST_PREFIX))
}

/** @deprecated Use isRiaRequestId. Kept for older callers and stored ids. */
export function isHostRequestId(value) {
  return isRiaRequestId(value)
}

/** @deprecated Use RIA_REQUEST_PREFIX. */
export const HOST_REQUEST_PREFIX = LEGACY_RIA_REQUEST_PREFIX
