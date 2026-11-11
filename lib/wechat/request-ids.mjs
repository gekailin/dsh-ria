// Request-id namespaces used to tell user messages apart.
//
// DSH records every prompt as a user/message with source { kind: 'user', rpcId }.
// The Web UI and other clients use their own request ids, WeChat inbound uses
// the wx_ prefix, and host-generated prompts (startup recovery, worker-idle
// wakeups) use host_. Only a user message outside the host namespace is a real
// non-WeChat channel message that should pause WeChat pushes.

export const WECHAT_REQUEST_PREFIX = 'wx_'
export const HOST_REQUEST_PREFIX = 'host_'

export function isWechatRequestId(value) {
  return typeof value === 'string' && value.startsWith(WECHAT_REQUEST_PREFIX)
}

export function isHostRequestId(value) {
  return typeof value === 'string' && value.startsWith(HOST_REQUEST_PREFIX)
}
