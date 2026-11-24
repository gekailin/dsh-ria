// Shared text helpers for new code.
/** Unicode code-point safe truncation with an optional suffix. */
export function clip(value, maxChars, suffix = '…') {
  const text = String(value === null || value === undefined ? '' : value)
  const chars = [...text]
  const limit = Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : 0
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('') + suffix
}

/** Character and UTF-8 byte counts; callers must not use .length directly. */
export function measureText(value) {
  const text = String(value === null || value === undefined ? '' : value)
  return {
    chars: [...text].length,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
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

/** Tokenize latin words and CJK bigrams for lightweight text search. */
export function tokenize(value) {
  const tokens = new Set()
  const body = String(value == null ? '' : value).toLowerCase()
  for (const word of body.match(/[a-z0-9][a-z0-9_.#-]*/g) || []) {
    if (word.length >= 2) tokens.add(word)
  }
  for (const run of body.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}
