// One measurement entry point for size checks.
//
// Characters are Unicode code points, not UTF-16 code units. Bytes are UTF-8
// bytes. Budget code must call measureText() instead of using text.length or
// Buffer.byteLength directly, so a name with a unit is always tied to the
// comparison it feeds.

export function measureText(value) {
  const text = String(value === null || value === undefined ? '' : value)
  return {
    chars: [...text].length,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}
