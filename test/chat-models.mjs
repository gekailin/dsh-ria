import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { MODEL_CATALOG_TTL_MS } from '../lib/core/model-catalog.mjs'

async function setup(options = {}) {
  const fixture = await createFixture({ state: true, ...options })
  const chat = fixture.service.controller.state.chatSessionId
  return { fixture, chat }
}

function byKey(models, provider, model) {
  return models.find(item => item.provider === provider && item.model === model)
}

// 1. Normal catalog: fields, default marker, count/source, and the 5-minute
// process-local cache (second call does not hit the registry; expiry does).
{
  const { fixture, chat } = await setup()
  try {
    const first = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(first.ok, true)
    assert.equal(first.source, 'catalog')
    assert.equal(first.count, 5)
    assert.equal(first.total, 5)
    assert.equal(first.models.length, 5)
    assert.equal(first.cached, false)
    for (const item of first.models) {
      assert.equal(typeof item.provider, 'string')
      assert.equal(typeof item.model, 'string')
      assert.equal(typeof item.displayName, 'string')
      assert.equal(item.source, 'catalog')
    }
    const vision = byKey(first.models, 'provider-ok', 'model-vision')
    assert.equal(vision.displayName, 'Vision Model')
    assert.equal(vision.contextWindow, 128000)
    assert.equal(vision.maxOutput, 8192)
    assert.equal(vision.default, true)
    const text = byKey(first.models, 'provider-text', 'model-text-only')
    assert.equal(text.displayName, 'Text Only Model')
    assert.equal(text.contextWindow, undefined)

    const second = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(second.cached, true)
    assert.equal(second.count, 5)
    assert.equal(fixture.modelCalls.listModels, 2) // one per provider on the first call only
    fixture.service.controller.modelCatalogCache.at = Date.now() - MODEL_CATALOG_TTL_MS - 1
    const third = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(third.cached, false)
    assert.equal(fixture.modelCalls.listModels, 4)
  } finally {
    fixture.cleanup()
  }
}

// 2. provider filter is exact.
{
  const { fixture, chat } = await setup()
  try {
    const result = await fixture.callAs(chat, 'ria_chat_models', { provider: 'provider-text' })
    assert.equal(result.ok, true)
    assert.equal(result.count, 2)
    assert.equal(result.total, 2)
    assert.deepEqual(result.models.map(item => item.provider), ['provider-text', 'provider-text'])
    const missing = await fixture.callAs(chat, 'ria_chat_models', { provider: 'provider-nope' })
    assert.equal(missing.ok, true)
    assert.equal(missing.count, 0)
    assert.equal(missing.source, 'catalog')
    assert.match(missing.message, /provider=provider-nope/)
  } finally {
    fixture.cleanup()
  }
}

// 3. query matches model id or displayName, case-insensitively.
{
  const { fixture, chat } = await setup()
  try {
    const byId = await fixture.callAs(chat, 'ria_chat_models', { query: 'VISION' })
    assert.equal(byId.count, 1)
    assert.equal(byId.models[0].model, 'model-vision')
    const byName = await fixture.callAs(chat, 'ria_chat_models', { query: 'text only' })
    assert.equal(byName.count, 1)
    assert.equal(byName.models[0].model, 'model-text-only')
    const shared = await fixture.callAs(chat, 'ria_chat_models', { query: 'shared' })
    assert.equal(shared.count, 2)
    assert.deepEqual(shared.models.map(item => item.provider).sort(), ['provider-ok', 'provider-text'])
  } finally {
    fixture.cleanup()
  }
}

// 4. limit defaults to 50, clamps the page to limit, and rejects invalid values.
{
  const { fixture, chat } = await setup()
  try {
    const defaults = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(defaults.count, 5)
    const capped = await fixture.callAs(chat, 'ria_chat_models', { limit: 2 })
    assert.equal(capped.ok, true)
    assert.equal(capped.count, 2)
    assert.equal(capped.total, 5)
    assert.equal(capped.models.length, 2)
    for (const limit of [0, 201, 1.5, 'many']) {
      const bad = await fixture.callAs(chat, 'ria_chat_models', { limit })
      assert.equal(bad.ok, false)
      assert.equal(bad.code, 'invalid_argument')
      assert.equal(bad.field, 'limit')
    }
  } finally {
    fixture.cleanup()
  }
}

// 5. Registry failure returns the bundled catalog with source + reason instead
// of failing the call.
{
  const { fixture, chat } = await setup({ failListModels: true })
  try {
    const result = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(result.ok, true)
    assert.equal(result.source, 'bundled-fallback')
    assert.equal(result.count, 2)
    assert.deepEqual(result.models.map(item => item.model), ['deepseek-flash', 'deepseek-v4-pro'])
    assert.equal(result.models.every(item => item.source === 'bundled-fallback'), true)
    assert.match(result.reason, /model directory unavailable/)
    assert.equal(result.failures.length, 2)
  } finally {
    fixture.cleanup()
  }
}

// 6. No llm registry at all is also a fallback, not an error.
{
  const { fixture, chat } = await setup({ noLlm: true })
  try {
    const result = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(result.ok, true)
    assert.equal(result.source, 'bundled-fallback')
    assert.equal(result.count, 2)
    assert.match(result.reason, /registry is unavailable/)
  } finally {
    fixture.cleanup()
  }
}

// 7. An empty registry is a successful empty result with a reason; it is not a
// failure and does not silently substitute the bundled list.
{
  const { fixture, chat } = await setup({ emptyModelCatalog: true })
  try {
    const result = await fixture.callAs(chat, 'ria_chat_models', {})
    assert.equal(result.ok, true)
    assert.equal(result.source, 'catalog')
    assert.equal(result.count, 0)
    assert.equal(result.total, 0)
    assert.deepEqual(result.models, [])
    assert.match(result.message, /模型目录为空/)
  } finally {
    fixture.cleanup()
  }
}

// 8. Non-Chat callers are rejected twice over: the tool is not installed on
// another role, and the direct execute path has its own forbidden guard.
{
  const { fixture, chat } = await setup()
  try {
    await assert.rejects(fixture.callAs('session-executor', 'ria_chat_models', {}), /tool not installed/)
    const direct = await fixture.service.controller.chatModels({}, { agent: { id: 'session-executor' } })
    assert.equal(direct.ok, false)
    assert.equal(direct.code, 'forbidden')
  } finally {
    fixture.cleanup()
  }
}

console.log('state chat models ok')
