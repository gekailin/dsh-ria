// Shared text helpers for new code.
export { measureText } from '../text-size.mjs'
import { measureText } from '../text-size.mjs'

/** Unicode code-point safe truncation with an optional suffix. */
export function clip(value, maxChars, suffix = '…') {
  const text = String(value === null || value === undefined ? '' : value)
  const chars = [...text]
  const limit = Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : 0
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('') + suffix
}

/** Detect a supported image from its magic bytes; null when unknown. */
export function imageMediaType(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  return null
}
