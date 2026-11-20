/**
 * Role identities for the v2 responsibility chain.
 *
 * The Chat role used to be called `chatbot`. Tool names (`chatbot_*`) and the
 * persisted store key `chatbotSessionId` keep the old spelling so existing
 * sessions, tickets and tools stay compatible; everything that carries a role
 * identity now says `chat`. Reads go through `normalizeRole` so historical
 * values persisted as `chatbot` keep working without a data migration.
 */

export const ROLE_CHAT = 'chat'
export const ROLE_ADVISOR = 'advisor'
export const ROLE_WORKER = 'worker'
export const ROLE_REFLECTION = 'reflection'
export const ROLE_SAGE = 'sage'

/** Role id this project shipped before the rename. Read-only compatibility. */
export const LEGACY_ROLE_CHAT = 'chatbot'

/**
 * Map a stored/historical role value onto the current identity.
 * Unknown values (session ids, 'ticket:<id>', null) pass through untouched.
 */
export function normalizeRole(role) {
  if (role === null || role === undefined) return role
  return String(role) === LEGACY_ROLE_CHAT ? ROLE_CHAT : role
}

/** True for the Chat role, including rows written before the rename. */
export function isChatRole(role) {
  return normalizeRole(role) === ROLE_CHAT
}
