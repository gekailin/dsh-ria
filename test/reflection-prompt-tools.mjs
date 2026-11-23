import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REFLECTION_TOOLS, reflectionInstruction } from '../lib/reflection.mjs'

assert.equal(REFLECTION_TOOLS.length, 8)
assert.ok(REFLECTION_TOOLS.includes('ria_reflect_read_sage_context'))
assert.ok(REFLECTION_TOOLS.includes('ria_reflect_read_role_context'))
const prompt = reflectionInstruction({ runId: 'r', forDate: '2026-11-23', windowStart: 1, windowEnd: 2, deadlineAt: 3, trigger: 'manual', attempt: 1 })
assert.ok(prompt.includes('这 8 个'))
assert.ok(prompt.includes('Sage 质量检查'))
assert.ok(prompt.includes('ria_reflect_read_sage_context'))
assert.ok(prompt.includes('ria_reflect_read_role_context'))
const registry = readFileSync(new URL('../lib/tools/registry.mjs', import.meta.url), 'utf8')
const catalog = readFileSync(new URL('../lib/tools/tool-catalog.mjs', import.meta.url), 'utf8')
assert.equal(/lesson_|lesson_search|lesson_review/.test(registry + catalog), false)
console.log('reflection prompt tools ok')
