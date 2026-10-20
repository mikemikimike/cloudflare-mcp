import { z } from 'zod'
import { extractProduct } from './spec-processor'

/**
 * `response-schemas.json`: every operation's response JSON Schemas, keyed by
 * `METHOD /path/template`, for checking direct-tool responses against the spec
 * (`src/response-validation.ts`).
 *
 * Kept out of `mcp-tools.json` so `tools/list` never loads it, and out of
 * `spec.json`, whose `resolveRefs` inlines every `$ref` (25 MB for responses
 * alone) and turns a `$ref` seen twice in one operation into `{$circular}`,
 * which accepts anything. Here component schemas stay shared in `defs` and
 * operations reference them as `#/$defs/<name>`.
 *
 * Schemas are converted from OpenAPI 3.0 to JSON Schema draft 4 so that a
 * response the spec allows is never reported:
 * - `nullable: true` adds `null` to `type` and `enum`, or wraps a typeless
 *   schema (often `$ref` + `nullable`) in `anyOf: [{type: null}, schema]`.
 * - `writeOnly` properties leave `required`, since responses omit them.
 * - A `pattern` that isn't a valid `u`-flag regex is dropped.
 * - Only validation keywords are kept; annotations (`description`,
 *   `example`, `discriminator`, `x-*`, …) are dropped to keep the file small.
 */

export const RESPONSE_SCHEMAS_KEY = 'response-schemas.json'

/** A normalised JSON Schema (draft 4), or a boolean schema. */
export type JsonSchema = boolean | { [keyword: string]: unknown }

export interface OperationResponses {
  /** Path segment after `{account_id}`/`{zone_id}`, else the first tag. */
  product: string
  /** First OpenAPI tag, for routing to the owning team. */
  tag?: string
  /**
   * Response key (`200`, `4XX`, `default`) to its JSON body schema. `null`
   * marks a documented response without a JSON schema, so lookup stops there
   * instead of falling back to a broader key.
   */
  responses: Record<string, JsonSchema | null>
}

export interface ResponseSchemas {
  version: 1
  defs: Record<string, JsonSchema>
  operations: Record<string, OperationResponses>
}

/** Shallow shape check when an isolate loads the artifact. */
export const ResponseSchemasArtifact = z.object({
  version: z.literal(1),
  defs: z.record(z.string(), z.unknown()),
  operations: z.record(
    z.string(),
    z.object({
      product: z.string(),
      tag: z.string().optional(),
      responses: z.record(z.string(), z.unknown())
    })
  )
})

/** The artifact key of an operation. */
export function operationKey(method: string, pathTemplate: string): string {
  return `${method.toUpperCase()} ${pathTemplate}`
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const SCHEMAS_PREFIX = '#/components/schemas/'
export const DEFS_PREFIX = '#/$defs/'
const INSTANCE_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string'
])

/** Keywords copied as-is. Everything else, except those handled below, is dropped. */
const SCALAR_KEYWORDS = [
  'required',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties'
] as const

export function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

type Raw = Record<string, unknown>

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the artifact from the raw (unresolved) OpenAPI spec. */
export function buildResponseSchemas(spec: Raw): ResponseSchemas {
  const components = isObject(spec.components) ? spec.components : {}
  const rawSchemas = isObject(components.schemas) ? components.schemas : {}

  const lookup = (ref: string): unknown =>
    ref
      .replace(/^#\//, '')
      .split('/')
      .map(decodePointerToken)
      .reduce<unknown>((node, part) => (isObject(node) ? node[part] : undefined), spec)

  const deref = (value: unknown): unknown => {
    const seen = new Set<string>()
    let node = value
    while (isObject(node) && typeof node.$ref === 'string' && !seen.has(node.$ref)) {
      seen.add(node.$ref)
      node = lookup(node.$ref)
    }
    return node
  }

  const defs: Record<string, JsonSchema> = {}
  const pending: string[] = []
  const queued = new Set<string>()
  const reference = (name: string) => {
    if (queued.has(name)) return
    queued.add(name)
    pending.push(name)
  }
  const normalise = (schema: unknown) => normaliseSchema(schema, deref, reference)

  const operations: Record<string, OperationResponses> = {}
  const paths = isObject(spec.paths) ? spec.paths : {}
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!isObject(operation) || !isObject(operation.responses)) continue

      const responses: Record<string, JsonSchema | null> = {}
      for (const [code, rawResponse] of Object.entries(operation.responses)) {
        const schema = jsonBodySchema(deref(rawResponse), deref)
        const key = code === 'default' ? code : code.toUpperCase()
        responses[key] = schema === undefined ? null : normalise(schema)
      }
      if (!Object.values(responses).some((schema) => schema !== null)) continue

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((tag): tag is string => typeof tag === 'string')
        : []
      operations[operationKey(method, path)] = {
        product: extractProduct(path) ?? tags[0] ?? 'unknown',
        ...(tags[0] ? { tag: tags[0] } : {}),
        responses
      }
    }
  }

  // Normalising a def can reference more defs, which join the queue.
  for (let i = 0; i < pending.length; i++) {
    const name = pending[i]
    defs[name] = normalise(rawSchemas[name] ?? true)
  }

  return { version: 1, defs, operations }
}

/** The response's JSON body schema: `application/json` first, then any `+json`/`json` type. */
function jsonBodySchema(response: unknown, deref: (value: unknown) => unknown): unknown {
  if (!isObject(response) || !isObject(response.content)) return undefined
  const types = Object.keys(response.content)
  const type =
    types.find((name) => name.toLowerCase().startsWith('application/json')) ??
    types.find((name) => /json/i.test(name))
  if (!type) return undefined
  const media = deref(response.content[type])
  return isObject(media) && media.schema !== undefined ? media.schema : undefined
}

function normaliseSchema(
  schema: unknown,
  deref: (value: unknown) => unknown,
  reference: (name: string) => void
): JsonSchema {
  if (typeof schema === 'boolean') return schema
  if (!isObject(schema)) return true
  const recurse = (value: unknown) => normaliseSchema(value, deref, reference)
  const nullable = schema.nullable === true

  if (typeof schema.$ref === 'string') {
    // OpenAPI 3.0 ignores $ref siblings; so does draft 4.
    if (!schema.$ref.startsWith(SCHEMAS_PREFIX)) return true
    const name = decodePointerToken(schema.$ref.slice(SCHEMAS_PREFIX.length))
    reference(name)
    const ref = { $ref: DEFS_PREFIX + encodePointerToken(name) }
    return nullable ? { anyOf: [{ type: 'null' }, ref] } : ref
  }

  const out: Raw = {}

  if (typeof schema.type === 'string' && INSTANCE_TYPES.has(schema.type)) {
    out.type = nullable && schema.type !== 'null' ? [schema.type, 'null'] : schema.type
  } else if (Array.isArray(schema.type)) {
    const types = schema.type.filter(
      (type): type is string => typeof type === 'string' && INSTANCE_TYPES.has(type)
    )
    if (nullable && !types.includes('null')) types.push('null')
    if (types.length > 0) out.type = types
  }

  if (Array.isArray(schema.enum)) {
    out.enum = nullable && !schema.enum.includes(null) ? [...schema.enum, null] : schema.enum
  }

  for (const keyword of SCALAR_KEYWORDS) {
    if (schema[keyword] !== undefined) out[keyword] = schema[keyword]
  }

  if (typeof schema.pattern === 'string' && compiles(schema.pattern)) out.pattern = schema.pattern

  for (const keyword of ['properties', 'patternProperties'] as const) {
    const map = schema[keyword]
    if (!isObject(map)) continue
    if (keyword === 'patternProperties') {
      out[keyword] = Object.fromEntries(
        Object.entries(map)
          .filter(([pattern]) => compiles(pattern))
          .map(([pattern, value]) => [pattern, recurse(value)])
      )
    } else {
      out[keyword] = Object.fromEntries(
        Object.entries(map).map(([name, value]) => [name, recurse(value)])
      )
    }
  }

  // Responses omit writeOnly properties even when they are required.
  if (Array.isArray(out.required) && isObject(schema.properties)) {
    const properties = schema.properties
    const required = out.required.filter((name) => {
      const property = typeof name === 'string' ? deref(properties[name]) : undefined
      return !(isObject(property) && property.writeOnly === true)
    })
    if (required.length > 0) out.required = required
    else delete out.required
  }

  for (const keyword of ['items', 'additionalProperties', 'not'] as const) {
    const value = schema[keyword]
    if (value === undefined) continue
    out[keyword] = Array.isArray(value) ? value.map(recurse) : recurse(value)
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const value = schema[keyword]
    if (Array.isArray(value)) out[keyword] = value.map(recurse)
  }

  const unconstrained = Object.keys(out).length === 0
  if (nullable && out.type === undefined && out.enum === undefined && !unconstrained) {
    return { anyOf: [{ type: 'null' }, out] }
  }
  return out
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u')
    return true
  } catch {
    return false
  }
}
