import { describe, expect, it } from 'vitest'
import {
  MAX_CHECKED_ITEMS,
  findMismatch,
  responseKeyFor,
  safeInstancePath
} from '../src/response-schema-check'
import { buildResponseSchemas, type ResponseSchemas } from '../src/response-schemas'
import { sampleRateFrom } from '../src/response-validation'

const PATH = '/zones/{zone_id}/dns_records'
const SECRET = 'customer-secret.example.com'

const ARTIFACT: ResponseSchemas = buildResponseSchemas({
  paths: {
    [PATH]: {
      get: {
        tags: ['DNS Records for a Zone'],
        responses: {
          '200': json({ $ref: '#/components/schemas/collection' }),
          '204': { description: 'No content' },
          '4XX': json({ $ref: '#/components/schemas/failure' }),
          default: json({ type: 'object', required: ['fallback'] })
        }
      }
    }
  },
  components: {
    schemas: {
      collection: {
        type: 'object',
        required: ['result'],
        properties: {
          result: { type: 'array', minItems: 30, items: { $ref: '#/components/schemas/record' } }
        }
      },
      record: {
        type: 'object',
        required: ['id', 'type'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['A', 'AAAA'] },
          ttl: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }] },
          meta: { type: 'object', additionalProperties: { type: 'integer' } }
        }
      },
      failure: {
        type: 'object',
        required: ['success', 'errors'],
        properties: { success: { type: 'boolean' }, errors: { type: 'array' } }
      }
    }
  }
})

function json(schema: unknown) {
  return { description: 'OK', content: { 'application/json': { schema } } }
}

function check(body: unknown, status = 200, method = 'GET', pathTemplate = PATH) {
  return findMismatch(ARTIFACT, { method, pathTemplate, status, body })
}

function records(count: number, record: Record<string, unknown> = { id: 'r', type: 'A' }) {
  return { result: Array.from({ length: count }, () => ({ ...record })) }
}

describe('findMismatch', () => {
  it('finds nothing when the body matches', () => {
    expect(check(records(30, { id: 'r', type: 'A', ttl: 'auto', meta: { a: 1 } }))).toBeUndefined()
  })

  it('names the keyword and the component schema it lives in', () => {
    const mismatch = check(records(30, { id: 'r', type: 'CNAME' }))

    expect(mismatch).toMatchObject({
      product: 'dns_records',
      tag: 'DNS Records for a Zone',
      responseKey: '200',
      // Only the first 25 items are checked.
      errorCount: 25,
      counted: false
    })
    expect(mismatch?.errors[0]).toEqual({
      keyword: 'enum',
      schemaLocation: '#/components/schemas/record/properties/type/enum',
      instancePath: '/result/*/type'
    })
  })

  it('locates violations in the response schema itself', () => {
    expect(check({}, 200)?.errors[0]).toEqual({
      keyword: 'required',
      schemaLocation: '#/components/schemas/collection/required',
      // The missing property, named by the schema.
      instancePath: '/result'
    })
    expect(check({ other: true }, 500)?.errors[0]).toEqual({
      keyword: 'required',
      schemaLocation: '#/responses/default/schema/required',
      instancePath: '/fallback'
    })
  })

  it('checks error responses: the status, then its class, then default', () => {
    expect(check({ success: false }, 403)).toMatchObject({
      responseKey: '4XX',
      errorCount: 1,
      counted: true,
      errors: [expect.objectContaining({ keyword: 'required' })]
    })
    expect(check({ success: false, errors: [] }, 404)).toBeUndefined()
    expect(check({}, 503)?.responseKey).toBe('default')
  })

  it('stops at a documented response that has no JSON schema', () => {
    expect(check({ anything: true }, 204)).toBeUndefined()
  })

  it('skips operations it has no schemas for', () => {
    expect(check({}, 200, 'POST')).toBeUndefined()
    expect(check({}, 200, 'GET', '/unknown')).toBeUndefined()
  })

  it('counts one violation for an anyOf, not one per alternative', () => {
    const mismatch = check(records(30, { id: 'r', type: 'A', ttl: true }))

    expect(mismatch?.errorCount).toBe(25)
    expect(mismatch?.errors[0]).toEqual({
      keyword: 'anyOf',
      schemaLocation: '#/components/schemas/record/properties/ttl/anyOf',
      instancePath: '/result/*/ttl'
    })
  })

  it('counts a declared property that fails once, though additionalProperties is false', () => {
    // The validator re-checks a failing declared property against
    // additionalProperties; that second report is dropped.
    expect(check(records(1, { id: 'r', type: 'MX' }))).toMatchObject({
      errorCount: 2,
      errors: [{ keyword: 'minItems' }, { keyword: 'enum' }]
    })
  })

  it('reports an unexpected property at its parent without naming it', () => {
    const mismatch = check(records(30, { id: 'r', type: 'A', [SECRET]: 'x' }))

    expect(mismatch?.errors[0]).toEqual({
      keyword: 'additionalProperties',
      schemaLocation: '#/components/schemas/record/additionalProperties',
      instancePath: '/result/*'
    })
  })

  it('never includes response values, keys the schema does not declare, or indices', () => {
    const body = records(30, { id: SECRET, type: SECRET, meta: { [SECRET]: SECRET } })

    const mismatch = check(body)

    expect(mismatch?.errors).toContainEqual({
      keyword: 'type',
      schemaLocation: '#/components/schemas/record/properties/meta/additionalProperties/type',
      instancePath: '/result/*/meta/*'
    })
    expect(JSON.stringify(mismatch)).not.toContain('customer-secret')
  })

  it(`checks only the first ${MAX_CHECKED_ITEMS} items of an array`, () => {
    const body = records(100)
    body.result[MAX_CHECKED_ITEMS] = { id: 'r', type: 'MX' }
    expect(check(body)).toBeUndefined()

    body.result[0] = { id: 'r', type: 'MX' }
    expect(check(body)).toMatchObject({ errorCount: 1, counted: false })
  })

  it('ignores minItems on an array it trimmed, but not on a whole one', () => {
    expect(check(records(MAX_CHECKED_ITEMS + 10))).toBeUndefined()
    expect(check(records(3))?.errors[0]).toMatchObject({
      keyword: 'minItems',
      instancePath: '/result'
    })
  })

  it('caches compiled validators without mutating the shared schemas', () => {
    const before = JSON.stringify(ARTIFACT)
    check(records(30))
    check(records(30, { id: 'r', type: 'X' }))
    expect(JSON.stringify(ARTIFACT)).toBe(before)
  })

  it('throws on a broken schema; the caller catches it', () => {
    const broken: ResponseSchemas = {
      version: 1,
      defs: {},
      operations: {
        'GET /broken': { product: 'p', responses: { '200': { $ref: '#/$defs/missing' } } }
      }
    }
    expect(() =>
      findMismatch(broken, { method: 'GET', pathTemplate: '/broken', status: 200, body: {} })
    ).toThrow()
  })
})

describe('responseKeyFor', () => {
  it('prefers the exact status, then its class, then default', () => {
    const responses = { '200': {}, '4XX': {}, default: {} }
    expect(responseKeyFor(responses, 200)).toBe('200')
    expect(responseKeyFor(responses, 429)).toBe('4XX')
    expect(responseKeyFor(responses, 500)).toBe('default')
    expect(responseKeyFor({ '200': {} }, 500)).toBeUndefined()
  })
})

describe('safeInstancePath', () => {
  it('keeps declared property names and replaces indices and other keys with *', () => {
    const declared = new Set(['result', 'meta', '0'])
    expect(safeInstancePath('#/result/12/meta/host.example.com', declared)).toBe('/result/*/meta/*')
    expect(safeInstancePath('#', declared)).toBe('/')
  })

  it("reads the validator's URI-encoded tokens", () => {
    const declared = new Set(['zone name', 'a/b'])
    expect(safeInstancePath('#/zone%20name/a~1b/caf%C3%A9', declared)).toBe('/zone name/a~1b/*')
  })
})

describe('sampleRateFrom', () => {
  it('reads a fraction, clamps it, and defaults to checking everything', () => {
    expect(sampleRateFrom('0.25')).toBe(0.25)
    expect(sampleRateFrom('0')).toBe(0)
    expect(sampleRateFrom('5')).toBe(1)
    expect(sampleRateFrom('-1')).toBe(0)
    expect(sampleRateFrom(undefined)).toBe(1)
    expect(sampleRateFrom('')).toBe(1)
    expect(sampleRateFrom('often')).toBe(1)
  })
})
