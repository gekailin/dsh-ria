// Strict input validation for every Ria tool registration.
//
// Tools are invoked by the model, so a misspelled or stale parameter must fail
// loudly instead of being dropped by a handler default. The registry and the
// reflection tool installer both send every call through this module before
// the handler runs; a rejected call never reaches business logic.
//
// Errors are structured so the UI and audit stream can show the field without
// having to parse a sentence:
//   { ok: false, code, tool, field, expected, got, allowed, message, ... }
//
// Legacy parameter names are hints only. They are never accepted as aliases:
// an unknown workerId still fails, but the message says to use executorId.

import { appendOperationLog } from '../state/operation-log.mjs'

export const LEGACY_PARAMETER_HINTS = Object.freeze({
  workerId: 'executorId',
  workerSeq: 'executorSeq',
  workerSessionId: 'executorSessionId',
  workerPreset: 'executorPreset',
})

const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function schemaTypes(schema) {
  if (!schema || typeof schema !== 'object') return []
  const type = schema.type
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter(item => TYPE_NAMES.has(item))
  return []
}

function matchesType(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return isPlainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'null') return value === null
  return true
}

function joinPath(prefix, key) {
  return prefix ? prefix + '.' + key : String(key)
}

function indexPath(prefix, index) {
  return prefix + '[' + index + ']'
}

function legalKeys(schema) {
  const properties = schema && schema.properties
  return properties && typeof properties === 'object' ? Object.keys(properties) : []
}

function expectedForSchema(schema) {
  const types = schemaTypes(schema)
  if (types.length) return types.join(' or ')
  if (Array.isArray(schema && schema.enum)) return 'one of ' + schema.enum.join(', ')
  return 'a valid value'
}

function shortValue(value) {
  let text
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) } catch { text = String(value) }
  }
  if (typeof text !== 'string') text = String(value)
  return text.length > 80 ? text.slice(0, 77) + '...' : text
}

function invalid(tool, code, field, expected, got, allowed, message, extra = {}) {
  return {
    ok: false,
    code,
    tool,
    field,
    expected,
    got,
    allowed: Array.isArray(allowed) ? allowed.slice() : [],
    message,
    ...extra,
  }
}

function unknownParameter(tool, unknown, schema, prefix) {
  const keys = legalKeys(schema)
  const fields = unknown.map(key => joinPath(prefix, key))
  const replacements = {}
  for (const key of unknown) {
    const replacement = LEGACY_PARAMETER_HINTS[key]
    if (replacement && keys.includes(replacement)) replacements[key] = replacement
  }
  const names = fields.map(name => JSON.stringify(name)).join(', ')
  let message = tool + ': unknown parameter' + (fields.length > 1 ? 's ' : ' ') + names
    + (keys.length ? '; allowed: ' + keys.join(', ') : '; this tool accepts no parameters')
  const hintParts = []
  for (const [legacy, replacement] of Object.entries(replacements)) {
    hintParts.push(JSON.stringify(legacy) + ' is a legacy parameter name; use ' + JSON.stringify(replacement))
  }
  if (hintParts.length) message += '. Hint: ' + hintParts.join('; ')
  const firstReplacement = Object.values(replacements)[0]
  return invalid(tool, 'unknown_parameter', fields[0], 'a known parameter', 'unknown', keys, message, {
    fields,
    unknownFields: fields,
    ...(firstReplacement ? { replacement: firstReplacement } : {}),
    ...(Object.keys(replacements).length ? { replacements } : {}),
  })
}

function missingRequired(tool, missing, schema, prefix) {
  const keys = legalKeys(schema)
  const fields = missing.map(key => joinPath(prefix, key))
  const names = fields.map(name => JSON.stringify(name)).join(', ')
  const message = tool + ': missing required parameter' + (fields.length > 1 ? 's ' : ' ') + names
    + (keys.length ? '; allowed: ' + keys.join(', ') : '')
  return invalid(tool, 'missing_required', fields[0], 'required parameter', 'missing', keys, message, {
    fields,
    missingFields: fields,
  })
}

function validateObject(tool, schema, value, prefix) {
  const properties = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const keys = Object.keys(properties)
  const strict = schema && (schema.additionalProperties === false || (schema.additionalProperties === undefined && keys.length > 0))
  if (strict) {
    const unknown = Object.keys(value).filter(key => !Object.hasOwn(properties, key))
    if (unknown.length) return unknownParameter(tool, unknown, schema, prefix)
  }
  if (Array.isArray(schema && schema.required)) {
    const missing = schema.required.filter(key => !Object.hasOwn(value, key) || value[key] === undefined)
    if (missing.length) return missingRequired(tool, missing, schema, prefix)
  }
  for (const [key, subschema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue
    const error = validateValue(tool, subschema, value[key], joinPath(prefix, key))
    if (error) return error
  }
  return null
}

function validateValue(tool, schema, value, field) {
  if (!schema || typeof schema !== 'object') return null

  if (Array.isArray(schema.anyOf)) {
    const errors = schema.anyOf.map(option => validateValue(tool, option, value, field))
    if (errors.every(Boolean)) {
      const expected = schema.anyOf.map(option => expectedForSchema(option)).join(' or ')
      return invalid(tool, 'invalid_argument', field, expected, valueType(value), [], tool + ': invalid value for parameter ' + JSON.stringify(field) + ': expected ' + expected + ', got ' + valueType(value))
    }
    return null
  }

  const types = schemaTypes(schema)
  if (types.length && !types.some(type => matchesType(value, type))) {
    const expected = types.join(' or ')
    return invalid(tool, 'invalid_argument', field, expected, valueType(value), types,
      tool + ': invalid value for parameter ' + JSON.stringify(field) + ': expected ' + expected + ', got ' + valueType(value))
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    const expected = 'one of ' + schema.enum.join(', ')
    return invalid(tool, 'invalid_argument', field, expected, shortValue(value), schema.enum,
      tool + ': invalid value for parameter ' + JSON.stringify(field) + ': expected ' + expected + ', got ' + shortValue(value))
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (Number.isFinite(schema.minLength) && length < schema.minLength) {
      return invalid(tool, 'invalid_argument', field, 'at least ' + schema.minLength + ' characters', 'string of ' + length + ' characters', [], tool + ': parameter ' + JSON.stringify(field) + ' is shorter than ' + schema.minLength + ' characters')
    }
    if (Number.isFinite(schema.maxLength) && length > schema.maxLength) {
      return invalid(tool, 'invalid_argument', field, 'at most ' + schema.maxLength + ' characters', 'string of ' + length + ' characters', [], tool + ': parameter ' + JSON.stringify(field) + ' is longer than ' + schema.maxLength + ' characters')
    }
    if (schema.pattern) {
      let pattern = null
      try { pattern = new RegExp(schema.pattern) } catch { pattern = null }
      if (pattern && !pattern.test(value)) {
        return invalid(tool, 'invalid_argument', field, 'string matching ' + schema.pattern, 'string', [], tool + ': parameter ' + JSON.stringify(field) + ' does not match ' + schema.pattern)
      }
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      return invalid(tool, 'invalid_argument', field, '>= ' + schema.minimum, String(value), [], tool + ': parameter ' + JSON.stringify(field) + ' must be >= ' + schema.minimum + ', got ' + value)
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      return invalid(tool, 'invalid_argument', field, '<= ' + schema.maximum, String(value), [], tool + ': parameter ' + JSON.stringify(field) + ' must be <= ' + schema.maximum + ', got ' + value)
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      return invalid(tool, 'invalid_argument', field, 'at least ' + schema.minItems + ' items', value.length + ' items', [], tool + ': parameter ' + JSON.stringify(field) + ' needs at least ' + schema.minItems + ' items')
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      return invalid(tool, 'invalid_argument', field, 'at most ' + schema.maxItems + ' items', value.length + ' items', [], tool + ': parameter ' + JSON.stringify(field) + ' accepts at most ' + schema.maxItems + ' items')
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateValue(tool, schema.items, value[index], indexPath(field, index))
        if (error) return error
      }
    }
  }

  if (isPlainObject(value)) {
    if ((schema.properties && Object.keys(schema.properties).length) || Array.isArray(schema.required) || schema.additionalProperties === false) {
      return validateObject(tool, schema, value, field)
    }
  }

  return null
}

/**
 * Validate one tool call. Returns null when the arguments are valid, otherwise
 * a structured error. Args undefined is treated as an empty object so a
 * missing required field is reported as missing_required, not invalid_argument.
 */
export function validateToolInput(tool, schema, args) {
  const value = args === undefined ? {} : args
  if (!isPlainObject(value)) {
    return invalid(tool, 'invalid_argument', '$', 'object', valueType(value), [],
      tool + ': arguments must be an object, got ' + valueType(value))
  }
  if (!schema || typeof schema !== 'object') return null
  return validateObject(tool, schema, value, '')
}

/**
 * Record a rejected call without copying the input. The operation log is the
 * durable audit trail; the router event makes the rejection visible in the
 * control-plane stream. Only tool/code/field metadata is written.
 */
export function recordInvalidToolInput({ stateDir, sessionId, error, routerEvent, log } = {}) {
  if (!error || error.ok !== false || !error.code) return
  const fields = Array.isArray(error.fields) && error.fields.length ? error.fields : [error.field]
  const payload = { tool: error.tool, code: error.code, field: error.field, fields }
  if (stateDir) {
    try {
      appendOperationLog(stateDir, {
        event: 'tool.input.invalid',
        caller: sessionId || null,
        tool: error.tool,
        code: error.code,
        field: error.field,
        fields,
      })
    } catch (writeError) {
      if (typeof log === 'function') log('warn', 'could not persist invalid tool input: ' + String(writeError && writeError.message ? writeError.message : writeError))
    }
  }
  if (typeof routerEvent === 'function') {
    try {
      routerEvent({
        event: 'tool.input.invalid',
        ticketId: null,
        sessionId: sessionId || null,
        actor: 'router',
        reason: 'tool input rejected: ' + error.code,
        payload,
      })
    } catch { /* observability must not break the rejection path */ }
  }
}
