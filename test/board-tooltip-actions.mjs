import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The board tooltip adds two tiny inline actions (复制 on the 工单 row, 跳转 on the
// 执行者 row). This test executes the real marker block with a fake React so the
// component's rendering, button props and event isolation are checked without a
// running host or a browser. The fake hooks mirror the two hooks the component
// uses, which lets a click advance state the same way React would.

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const startMarker = '/* board-tooltip-actions:start */'
const endMarker = '/* board-tooltip-actions:end */'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker)
assert.ok(start >= 0 && end > start, 'client board-tooltip-actions markers')
const block = source.slice(start + startMarker.length, end)

const HOOK_SLOT = { value: 0 }
const hookValues = []
const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { type, props: props || {}, children }
  },
  useState(initial) {
    const slot = HOOK_SLOT.value
    HOOK_SLOT.value += 1
    if (!(slot in hookValues)) hookValues[slot] = initial
    return [hookValues[slot], function (next) {
      hookValues[slot] = typeof next === 'function' ? next(hookValues[slot]) : next
    }]
  },
  useRef(initial) {
    const slot = HOOK_SLOT.value
    HOOK_SLOT.value += 1
    if (!(slot in hookValues) || !hookValues[slot] || !('current' in hookValues[slot])) hookValues[slot] = { current: initial }
    return hookValues[slot]
  },
  useEffect() {},
  useLayoutEffect() {},
  resetHooks() { HOOK_SLOT.value = 0 }
}

let timerSeq = 0
const timers = new Map()
function fakeSetTimeout(fn, ms) {
  timerSeq += 1
  timers.set(timerSeq, { fn, ms })
  return timerSeq
}
function fakeClearTimeout(id) { timers.delete(id) }
function runTimers(ms) {
  for (const [id, timer] of Array.from(timers)) {
    if (timer.ms !== ms) continue
    timers.delete(id)
    timer.fn()
  }
}

const written = []
function fakeWriteClipboard(text) {
  written.push(text)
  return Promise.resolve()
}
function boardCanOpenSession(ticket) {
  return Boolean(ticket && ticket.executor && ticket.executor !== 'self' &&
    !ticket.executorMissing && !ticket.executorArchived)
}
function boardStatus(status) { return { label: status || '—' } }
function boardExecutor(ticket) {
  if (ticket.executor === 'self') return 'Ria'
  if (ticket.executorTitle) return ticket.executorTitle
  return '未分配'
}
function topicClockText(value) { return value ? '11-25 13:59' : '—' }

const factory = new Function(
  'React',
  'BOARD_TOOLTIP_WIDTH',
  'boardCanOpenSession',
  'boardStatus',
  'boardExecutor',
  'topicClockText',
  'boardWriteClipboard',
  'setTimeout',
  'clearTimeout',
  block + '\nreturn { BoardTooltip: BoardTooltip, boardTooltipCopySpec: boardTooltipCopySpec, boardTooltipJumpSpec: boardTooltipJumpSpec, BOARD_TOOLTIP_COPY_FLASH_MS: BOARD_TOOLTIP_COPY_FLASH_MS };'
)

function load(overrides) {
  const options = overrides || {}
  return factory(
    React,
    330,
    options.boardCanOpenSession || boardCanOpenSession,
    boardStatus,
    boardExecutor,
    topicClockText,
    options.boardWriteClipboard || fakeWriteClipboard,
    fakeSetTimeout,
    fakeClearTimeout
  )
}

const api = load()
assert.equal(api.BOARD_TOOLTIP_COPY_FLASH_MS, 1500, 'copy feedback reverts after 1.5s')

function collect(node, out) {
  if (node == null || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (node.children) collect(node.children, out)
  return out
}
function nodesOf(tooltip) { return collect(tooltip, []) }
function actionNodes(tooltip) {
  return nodesOf(tooltip).filter(node => node.props && node.props['data-ria-tooltip-btn'])
}
function actionNode(tooltip, kind) {
  return actionNodes(tooltip).find(node => node.props['data-ria-tooltip-btn'] === kind)
}
function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}
function rowOf(tooltip, label) {
  return nodesOf(tooltip).find(node => node.type === 'div' && Array.isArray(node.children) && textOf(node.children[0]) === label)
}
function fakeEvent() {
  return { stopped: 0, stopPropagation() { this.stopped += 1 } }
}
function render(props) {
  React.resetHooks()
  return api.BoardTooltip(Object.assign({ left: 10, top: 10 }, props))
}

const ticket = {
  ticketId: 'ticket_mwvpz4qn_755d4cc996',
  executor: 'session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9',
  executorTitle: 'Ria 文档',
  status: '进行中',
  updatedAt: 1000
}

const opened = []
const tooltip = render({ ticket, onOpenSession: sessionId => opened.push(sessionId) })

const copy = actionNode(tooltip, 'copy')
const jump = actionNode(tooltip, 'jump')
assert.ok(copy, '工单 row has a copy button')
assert.ok(jump, '执行者 row has a jump button')
assert.equal(textOf(copy), '复制')
assert.equal(textOf(jump), '跳转')
assert.equal(copy.props.disabled, false)
assert.equal(jump.props.disabled, false)
assert.equal(copy.props.title, '复制完整工单编号')
assert.match(jump.props.title, /session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9/)

const ticketRow = rowOf(tooltip, '工单')
const executorRow = rowOf(tooltip, '执行者')
assert.ok(ticketRow, 'ticket row rendered')
assert.ok(executorRow, 'executor row rendered')
assert.ok(textOf(ticketRow).includes('ticket_mwvpz4qn_755d4cc996'), 'full ticket id remains in the row')
assert.ok(textOf(executorRow).includes('session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9'), 'session id remains in the row')
assert.match(textOf(ticketRow), /复制$/, 'copy button follows the ticket id')
assert.match(textOf(executorRow), /跳转$/, 'jump button follows the session id')

// Values stay on one ellipsized line; the buttons sit after them.
const valueSpans = nodesOf(tooltip).filter(node => node.type === 'span' && node.props && node.props.title)
const ticketValue = valueSpans.find(node => node.props.title === 'ticket_mwvpz4qn_755d4cc996')
const executorValue = valueSpans.find(node => node.props.title && node.props.title.includes('session-3315a7c9'))
assert.ok(ticketValue, 'ticket value has its full text in title')
assert.ok(executorValue, 'session value has its full text in title')
for (const value of [ticketValue, executorValue]) {
  assert.equal(value.props.style.textOverflow, 'ellipsis')
  assert.equal(value.props.style.whiteSpace, 'nowrap')
  assert.equal(value.props.style.overflow, 'hidden')
}
assert.equal(copy.props.style.height, '16px', 'small button does not heighten the row')
assert.equal(copy.props.style.fontSize, '9.5px')
assert.equal(jump.props.style.height, '16px')
assert.equal(tooltip.props.style.width, '330px', 'tooltip width is unchanged')

// Copy writes the full ticket id, reports success, then reverts on the 1.5s timer.
const copyEvent = fakeEvent()
copy.props.onClick(copyEvent)
assert.equal(copyEvent.stopped, 1, 'copy click stops propagation')
assert.deepEqual(written, ['ticket_mwvpz4qn_755d4cc996'], 'clipboard receives the full id, not the truncated label')
await Promise.resolve()
await Promise.resolve()
const afterCopy = render({ ticket, onOpenSession: sessionId => opened.push(sessionId) })
assert.equal(textOf(actionNode(afterCopy, 'copy')), '已复制', 'success feedback shows 已复制')
assert.equal(actionNode(afterCopy, 'copy').props.disabled, false)
assert.ok(Array.from(timers.values()).some(timer => timer.ms === 1500), 'revert timer is 1.5s')
runTimers(1500)
const reverted = render({ ticket, onOpenSession: sessionId => opened.push(sessionId) })
assert.equal(textOf(actionNode(reverted, 'copy')), '复制', 'label reverts to 复制')

// A click on the 1.5s timer does not leave a stale timer behind.
assert.equal(timers.size, 0, 'timer cleared after firing')

// Jump opens the executor session and stops propagation on all pointer events.
const jumpEvent = fakeEvent()
actionNode(reverted, 'jump').props.onClick(jumpEvent)
assert.deepEqual(opened, ['session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9'], 'jump target is the executor session id')
assert.equal(jumpEvent.stopped, 1, 'jump click stops propagation')
for (const kind of ['copy', 'jump']) {
  const node = actionNode(reverted, kind)
  const down = fakeEvent()
  const pointer = fakeEvent()
  node.props.onMouseDown(down)
  node.props.onPointerDown(pointer)
  assert.equal(down.stopped, 1)
  assert.equal(pointer.stopped, 1)
}

// Missing executor: disabled with an explanatory title and no side effect.
const noExecutor = render({ ticket: Object.assign({}, ticket, { executor: '', executorTitle: '' }), onOpenSession: sessionId => opened.push(sessionId) })
const disabledJump = actionNode(noExecutor, 'jump')
assert.equal(disabledJump.props.disabled, true, 'no session id disables jump')
assert.match(disabledJump.props.title, /没有执行者会话/, 'disabled jump explains why')
const disabledEvent = fakeEvent()
disabledJump.props.onClick(disabledEvent)
assert.equal(disabledEvent.stopped, 1, 'disabled click still stops propagation')
assert.equal(opened.length, 1, 'disabled click opens nothing')

// A missing/archived executor session is disabled too.
for (const flags of [{ executorMissing: true }, { executorArchived: true }]) {
  const missing = render({ ticket: Object.assign({}, ticket, flags), onOpenSession: sessionId => opened.push(sessionId) })
  const node = actionNode(missing, 'jump')
  assert.equal(node.props.disabled, true, 'missing/archived session disables jump')
  assert.match(node.props.title, /无法跳转/, 'disabled state explains why')
  node.props.onClick(fakeEvent())
  assert.equal(opened.length, 1, 'missing/archived click opens nothing')
}

// The Ria self executor has no jump target in this payload.
const selfTicket = render({ ticket: Object.assign({}, ticket, { executor: 'self' }), onOpenSession: sessionId => opened.push(sessionId) })
assert.equal(actionNode(selfTicket, 'jump').props.disabled, true)
assert.match(actionNode(selfTicket, 'jump').props.title, /Ria 自身/)

// No opener prop: jump is disabled and says so, rather than pretending it works.
const noOpener = render({ ticket })
const noOpenerJump = actionNode(noOpener, 'jump')
assert.equal(noOpenerJump.props.disabled, true)
assert.match(noOpenerJump.props.title, /没有会话跳转入口/)

// Custom rows (cognition tooltips) keep their old rendering and get no actions.
const custom = render({ ticket, rows: [['自定义', 'value']], onOpenSession: sessionId => opened.push(sessionId) })
assert.equal(actionNodes(custom).length, 0, 'custom rows stay untouched')

// Clipboard failure is visible, not silent.
const failing = load({ boardWriteClipboard: () => Promise.reject(new Error('denied')) })
const failingTip = (React.resetHooks(), failing.BoardTooltip({ ticket: ticket, left: 0, top: 0, onOpenSession() {} }))
actionNode(failingTip, 'copy').props.onClick(fakeEvent())
await Promise.resolve()
await Promise.resolve()
const failedTip = (React.resetHooks(), failing.BoardTooltip({ ticket: ticket, left: 0, top: 0, onOpenSession() {} }))
assert.equal(textOf(actionNode(failedTip, 'copy')), '复制失败', 'clipboard failure is shown')

// Integration: both live tooltip call sites hand the tooltip a session opener.
assert.ok(source.includes('onOpenSession: openSession'), 'tooltip call sites receive the board opener')
const tooltipSites = source.match(/React\.createElement\(BoardTooltip, \{[\s\S]*?\}\)/g) || []
assert.ok(tooltipSites.length >= 2, 'board tooltip call sites found')
assert.ok(tooltipSites.filter(site => site.includes('onOpenSession: openSession')).length >= 2, 'both live tooltip call sites pass the opener')
assert.match(source, /"data-ria-ticket-copy": "1"/, 'detail dialog copy button is untouched')

console.log('board tooltip actions ok')
