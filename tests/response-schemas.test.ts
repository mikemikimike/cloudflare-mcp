import { describe, expect, it } from 'vitest'
import { buildResponseSchemas, operationKey } from '../src/response-schemas'

/** A spec with one GET operation whose responses are `responses`. */
function specWith(
  responses: Record<string, unknown>,
  components: Record<string, unknown> = {},
  path = '/zones/{zone_id}/dns_records'
) {
  return {
    paths: { [path]: { get: { tags: ['DNS Records for a Zone'], responses } } },
    components: { schemas: components }
  }
}

function json(schema: unknown) {
  return { description: 'OK', content: { 'application/json': { schema } } }
}

describe('buildResponseSchemas', () => {
  it('keys operations by method and path template and routes them to a product and tag', () => {
    const artifact = buildResponseSchemas(specWith({ '200': json({ type: 'object' }) }))

    expect(artifact.operations).toEqual({
      'GET /zones/{zone_id}/dns_records': {
        product: 'dns_records',
        tag: 'DNS Records for a Zone',
        responses: { '200': { type: 'object' } }
      }
    })
    expect(operationKey('get', '/zones/{zone_id}/dns_records')).toBe(
      'GET /zones/{zone_id}/dns_records'
    )
  })

  it('falls back to the first tag as the product for paths outside accounts and zones', () => {
    const artifact = buildResponseSchemas(specWith({ '200': json({}) }, {}, '/user'))

    expect(artifact.operations['GET /user'].product).toBe('DNS Records for a Zone')
  })

  it('keeps every status, upper-cases ranges, and marks responses without a JSON body null', () => {
    const artifact = buildResponseSchemas(
      specWith({
        '200': json({ type: 'object' }),
        '204': { description: 'No content' },
        '4xx': json({ type: 'object' }),
        '500': { description: 'Text', content: { 'text/plain': { schema: { type: 'string' } } } },
        default: json({ type: 'object' })
      })
    )

    expect(artifact.operations['GET /zones/{zone_id}/dns_records'].responses).toEqual({
      '200': { type: 'object' },
      '204': null,
      '4XX': { type: 'object' },
      '500': null,
      default: { type: 'object' }
    })
  })

  it('reads +json media types and resolves $ref responses', () => {
    const spec = {
      ...specWith({
        '200': { $ref: '#/components/responses/ok' },
        '201': { description: 'SCIM', content: { 'application/scim+json': { schema: {} } } }
      }),
      components: { schemas: {}, responses: { ok: json({ type: 'string' }) } }
    }

    expect(
      buildResponseSchemas(spec).operations['GET /zones/{zone_id}/dns_records'].responses
    ).toEqual({ '200': { type: 'string' }, '201': {} })
  })

  it('leaves out operations with no JSON response schema', () => {
    expect(buildResponseSchemas(specWith({ '204': { description: 'No content' } }))).toEqual({
      version: 1,
      defs: {},
      operations: {}
    })
  })

  it('shares component schemas as $defs, including ones reached only through other defs', () => {
    const artifact = buildResponseSchemas(
      specWith(
        { '200': json({ $ref: '#/components/schemas/collection' }) },
        {
          collection: { type: 'array', items: { $ref: '#/components/schemas/record' } },
          record: { type: 'object', properties: { next: { $ref: '#/components/schemas/record' } } },
          unused: { type: 'string' }
        }
      )
    )

    expect(artifact.operations['GET /zones/{zone_id}/dns_records'].responses['200']).toEqual({
      $ref: '#/$defs/collection'
    })
    expect(artifact.defs).toEqual({
      collection: { type: 'array', items: { $ref: '#/$defs/record' } },
      record: { type: 'object', properties: { next: { $ref: '#/$defs/record' } } }
    })
  })

  it('lets null through wherever OpenAPI 3.0 says nullable', () => {
    const artifact = buildResponseSchemas(
      specWith(
        {
          '200': json({
            type: 'object',
            properties: {
              typed: { type: 'string', nullable: true },
              enumerated: { type: 'string', enum: ['a', 'b'], nullable: true },
              referenced: { $ref: '#/components/schemas/thing', nullable: true },
              composed: { allOf: [{ type: 'object' }], nullable: true }
            }
          })
        },
        { thing: { type: 'object' } }
      )
    )

    expect(artifact.operations['GET /zones/{zone_id}/dns_records'].responses['200']).toMatchObject({
      properties: {
        typed: { type: ['string', 'null'] },
        enumerated: { type: ['string', 'null'], enum: ['a', 'b', null] },
        referenced: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/thing' }] },
        composed: { anyOf: [{ type: 'null' }, { allOf: [{ type: 'object' }] }] }
      }
    })
  })

  it('drops writeOnly properties from required, since responses omit them', () => {
    const artifact = buildResponseSchemas(
      specWith(
        {
          '200': json({
            type: 'object',
            required: ['id', 'secret', 'token'],
            properties: {
              id: { type: 'string' },
              secret: { type: 'string', writeOnly: true },
              token: { $ref: '#/components/schemas/token' }
            }
          })
        },
        { token: { type: 'string', writeOnly: true } }
      )
    )

    expect(artifact.operations['GET /zones/{zone_id}/dns_records'].responses['200']).toMatchObject({
      required: ['id']
    })
  })

  it('keeps validation keywords only, and drops patterns JavaScript cannot compile', () => {
    const artifact = buildResponseSchemas(
      specWith({
        '200': json({
          type: 'object',
          description: 'A record',
          example: { id: 'x' },
          'x-auditable': true,
          discriminator: { propertyName: 'type' },
          properties: {
            description: { type: 'string', pattern: '^[a-z]+$', maxLength: 5 },
            bad: { type: 'string', pattern: '(?<!\\p{Foo})' }
          },
          patternProperties: { '^ok$': { type: 'string' }, '(?P<name>x)': { type: 'string' } },
          additionalProperties: false
        })
      })
    )

    expect(artifact.operations['GET /zones/{zone_id}/dns_records'].responses['200']).toEqual({
      type: 'object',
      properties: {
        // A property named like an annotation keyword is kept.
        description: { type: 'string', pattern: '^[a-z]+$', maxLength: 5 },
        bad: { type: 'string' }
      },
      patternProperties: { '^ok$': { type: 'string' } },
      additionalProperties: false
    })
  })
})
