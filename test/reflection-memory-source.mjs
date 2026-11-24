import assert from 'node:assert/strict'
import { reflectionInstruction, reflectionMemorySourceSection, ensureReflectionMemorySource, REFLECTION_MEMORY_SOURCE } from '../lib/reflection.mjs'

const section = reflectionMemorySourceSection()
assert.match(section, /记忆来源：SQLite cognition_entries \/ cognition_projects \/ cognition_proposals/)
assert.match(section, /cognition_entries\.id/) 

const report = '---\nschema: 2\n---\n## 一句话\nbody\n## 覆盖与成本\nold\n'
const filled = ensureReflectionMemorySource(report)
assert.ok(filled.includes('记忆来源：' + REFLECTION_MEMORY_SOURCE))
assert.ok(filled.includes('## 记忆来源'))
assert.ok(filled.indexOf('## 记忆来源') < filled.indexOf('## 覆盖与成本'))
assert.equal(ensureReflectionMemorySource(filled), filled)

const instruction = reflectionInstruction({ runId: 'refl-test', forDate: '2026-11-20', windowStart: 1, windowEnd: 2, deadlineAt: 3 })
assert.ok(instruction.includes('记忆来源：SQLite cognition_entries / cognition_projects / cognition_proposals'))
console.log('reflection memory source ok')
