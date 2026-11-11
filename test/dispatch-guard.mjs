import assert from 'node:assert/strict'
import {
  DISPATCH_GUARD_SECTION_NAME,
  DISPATCH_GUARD_SECTION_ORDER,
  DISPATCH_GUARD_TEXT,
  DispatchGuard,
} from '../lib/dispatch-guard.mjs'

function makeAgent(id) {
  const sections = []
  const agent = {
    id,
    sections,
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => { section.disposed = true }
        },
      },
    },
  }
  return agent
}

const listeners = new Map()
const warnings = []
let enabled = true
const ctx = {
  agents: { list: () => [a, b, broken] },
  on(name, handler) {
    const list = listeners.get(name) || []
    list.push(handler)
    listeners.set(name, list)
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  },
}
const a = makeAgent('agent-a')
const b = makeAgent('agent-b')
const broken = { id: 'agent-broken', ctx: { systemPrompt: { section() { throw new Error('no section here') } } } }
const later = makeAgent('agent-later')

const guard = new DispatchGuard({
  ctx,
  enabled: () => enabled,
  log: (level, message) => warnings.push({ level, message }),
})

assert.equal(guard.installAll(), 2)
assert.equal(a.sections.length, 1)
assert.equal(b.sections.length, 1)
assert.equal(a.sections[0].name, DISPATCH_GUARD_SECTION_NAME)
assert.equal(a.sections[0].order, DISPATCH_GUARD_SECTION_ORDER)
assert.equal(a.sections[0].interpolate, false)
assert.equal(a.sections[0].text(), DISPATCH_GUARD_TEXT)
assert.match(a.sections[0].text(), /clearly unrelated/)
assert.match(a.sections[0].text(), /ask the user to confirm/)
assert.match(a.sections[0].text(), /proceed normally/)
assert.doesNotMatch(a.sections[0].text(), /^#/m)
assert.doesNotMatch(a.sections[0].text(), /super session/i)
assert.equal(warnings.length, 1)
assert.match(warnings[0].message, /agent-broken/)

assert.equal(guard.install(a), false)
assert.equal(a.sections.length, 1)

const cleanup = guard.subscribe()
assert.equal(guard.install(later), true)
assert.equal(later.sections.length, 1)

enabled = false
assert.equal(a.sections[0].text(), '')
enabled = true
assert.equal(a.sections[0].text(), DISPATCH_GUARD_TEXT)

for (const handler of [...(listeners.get('agent/created') || [])]) handler({ agent: makeAgent('agent-created') })
assert.equal(guard.entries.size, 4)

assert.equal(guard.dispose('agent-a', b), false)
assert.equal(guard.dispose('agent-a'), true)
assert.equal(a.sections[0].disposed, true)
assert.equal(guard.dispose('agent-a'), false)

for (const handler of [...(listeners.get('agent/disposed') || [])]) handler({ agent: b })
assert.equal(b.sections[0].disposed, true)
assert.equal(guard.entries.has('agent-b'), false)

cleanup()
assert.equal((listeners.get('agent/created') || []).length, 0)
guard.shutdown()
assert.equal(guard.entries.size, 0)

console.log('dispatch-guard ok')
