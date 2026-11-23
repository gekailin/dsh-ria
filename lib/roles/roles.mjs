/**
 * Role identities for the state responsibility chain.
 *
 * The role id is `chat` (the session faces the user and is titled "Ria").
 * Tool names keep the historical `chat_*` spelling; nothing else does.
 */

export const ROLE_CHAT = 'chat'
export const ROLE_ADVISOR = 'advisor'
export const ROLE_EXECUTOR = 'executor'
export const ROLE_REFLECTION = 'reflection'
export const ROLE_SAGE = 'sage'

/** True for the Chat role. */
export function isChatRole(role) {
  return role === ROLE_CHAT
}
