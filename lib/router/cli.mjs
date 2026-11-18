import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { cases, decisionMatches, routeWithModel } from './index.mjs'
import { createHttpModel, resolveProvider } from './http-model.mjs'

const USAGE = [
  'Usage:',
  '  node lib/router/cli.mjs [--provider auto|friday|mccodex] [--case p1] [--json]',
  '  node lib/router/cli.mjs --mode project|session --request "...text..."',
  '',
  'Environment:',
  '  FRIDAY_API_KEY   Bearer token for the local FRIDAY endpoint',
  '  MCCODEX_API_KEY  Optional token for MCCODEX (defaults to mccodex)',
].join('\n')

function parseCli() {
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      provider: { type: 'string', default: 'auto' },
      case: { type: 'string' },
      mode: { type: 'string' },
      request: { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      'max-tokens': { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })
  return parsed.values
}

function selectedCases(values) {
  if (values.case !== undefined) {
    const found = cases.find(item => item.id === values.case)
    if (!found) throw new Error('unknown case: ' + values.case)
    return [found]
  }
  if (values.mode !== undefined || values.request !== undefined) {
    if (values.mode !== 'project' && values.mode !== 'session') {
      throw new Error('--mode must be project or session')
    }
    if (!values.request || !String(values.request).trim()) throw new Error('--request is required')
    return [{ id: 'custom', mode: values.mode, request: String(values.request), acceptable: [] }]
  }
  return cases
}

function printTable(results) {
  for (const result of results) {
    const decision = result.decision || {}
    const top = decision.top ? decision.top.id + ' ' + decision.top.rawScore : '(none)'
    console.log([
      result.caseId.padEnd(3),
      String(result.mode).padEnd(7),
      top.padEnd(28),
      String(decision.action || 'error').padEnd(16),
      result.match === undefined ? '' : (result.match ? 'match' : 'MISS'),
    ].join('  '))
  }
}

async function main() {
  const values = parseCli()
  if (values.help) {
    console.log(USAGE)
    return
  }
  const selected = selectedCases(values)
  const resolved = await resolveProvider(values.provider)
  if (resolved.fallback) {
    console.error('FRIDAY unavailable (' + resolved.fallback.reason + '), falling back to MCCODEX')
  }
  const model = createHttpModel(resolved.name, {
    maxTokens: values['max-tokens'] === undefined ? 1000 : Number(values['max-tokens']),
    timeoutMs: values.timeout === undefined ? 120000 : Number(values.timeout),
  })

  const results = []
  let failed = false
  for (const item of selected) {
    try {
      const result = await routeWithModel({
        model,
        mode: item.mode,
        request: item.request,
        options: {
          maxTokens: values['max-tokens'] === undefined ? 1000 : Number(values['max-tokens']),
          timeoutMs: values.timeout === undefined ? 120000 : Number(values.timeout),
        },
      })
      results.push({
        caseId: item.id,
        mode: item.mode,
        request: item.request,
        expected: item.acceptable,
        match: item.acceptable.length ? decisionMatches(result.decision, item.acceptable) : undefined,
        ...result,
      })
    } catch (error) {
      failed = true
      results.push({
        caseId: item.id,
        mode: item.mode,
        request: item.request,
        error: String(error && error.message ? error.message : error),
        code: error && error.code ? error.code : 'router_failed',
      })
    }
  }

  if (values.json) {
    const payload = { provider: resolved.name, model: model.model, results }
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(payload, null, 2) + '\n')
      console.error('wrote ' + values.out)
    } else {
      console.log(JSON.stringify(payload, null, 2))
    }
  } else {
    printTable(results)
    if (values.out) {
      writeFileSync(values.out, JSON.stringify({ provider: resolved.name, model: model.model, results }, null, 2) + '\n')
      console.error('wrote ' + values.out)
    }
  }

  if (failed) process.exitCode = 1
}

main().catch(error => {
  console.error(String(error && error.stack ? error.stack : error))
  process.exitCode = 1
})
