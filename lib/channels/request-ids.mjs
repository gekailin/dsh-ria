// Request-id namespaces for the chat channels. Ria uses the prefix to tell
// which channel a queued user message came from; the matching channel resumes
// its own outbound mirror and the others pause theirs, so a reply is not
// duplicated across connected channels.

import { isRiaRequestId } from '../wechat/request-ids.mjs'

export const WECHAT_CLAW_REQUEST_PREFIX = 'wc_'
export const QQ_REQUEST_PREFIX = 'qq_'

export function isWechatClawRequestId(value) {
  return typeof value === 'string' && value.startsWith(WECHAT_CLAW_REQUEST_PREFIX)
}

export function isQqRequestId(value) {
  return typeof value === 'string' && value.startsWith(QQ_REQUEST_PREFIX)
}

// Used by the channels to detect messages that entered Ria through another
// transport. dsh-ria's own injected prompts (ria_ now, host_ in older logs) are
// ignored by channel observers just like the legacy WeChat service does.
export function isForeignChannelRequestId(value, ownPrefix) {
  if (typeof value !== 'string' || !value) return false
  if (isRiaRequestId(value)) return false
  return !value.startsWith(ownPrefix)
}
