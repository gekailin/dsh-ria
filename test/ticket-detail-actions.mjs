import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// The detail dialog header is title-only; the old ticket-id/executor subtitle
// row is gone and its actions moved into 基本信息.
assert.match(source, /"data-ria-ticket-title": "1"/)
assert.doesNotMatch(source, /"data-ria-ticket-id": ticketId/)
assert.match(source, /"data-ria-ticket-detail-action": "copy"/)
assert.match(source, /"data-ria-ticket-detail-action": "jump"/)
assert.match(source, /"data-ria-ticket-copy": "1"/)
assert.match(source, /"data-ria-ticket-executor-title": "1"/)

// Both rows share one compact value/action renderer and keep the value on a
// single ellipsized line. Copy writes the full ticketId; jump uses canOpen.
assert.match(source, /function detailValueWithAction/)
assert.match(source, /textOverflow: "ellipsis"/)
assert.match(source, /boardTooltipActionButton\(\{/)
assert.match(source, /boardWriteClipboard\(ticketId\)/)
assert.match(source, /kind: "jump"/)
assert.match(source, /jumpDisabled = !sessionId \|\| !canOpen/)
assert.match(source, /stopTooltipActionEvent\(event\)/)

console.log('ticket detail actions ok')