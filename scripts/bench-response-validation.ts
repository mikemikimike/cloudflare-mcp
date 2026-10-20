/**
 * Measures what checking a direct-tool response costs: building
 * `response-schemas.json`, compiling an operation's validator, and validating
 * bodies of growing size that match, or break, the schema.
 *
 * Bodies are synthesised from each operation's own schema, so they are shaped
 * like real responses. Runs in Node (same V8 as workerd) and writes nothing.
 *
 *   npx tsx scripts/bench-response-validation.ts [path/to/openapi.json]
 *
 * Without a path it downloads the public spec.
 */
import { readFileSync } from 'node:fs'
import { findMismatch } from '../src/response-schema-check'
import {
  DEFS_PREFIX,
  buildResponseSchemas,
  decodePointerToken,
  type JsonSchema,
  type ResponseSchemas
} from '../src/response-schemas'

const SPEC_URL = 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json'

const specText = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(SPEC_URL)).text()
const spec = JSON.parse(specText) as Record<string, unknown>

let start = performance.now()
const schemas = buildResponseSchemas(spec)
const artifactJson = JSON.stringify(schemas)
console.log(
  `build: ${ms(start)}, artifact ${(artifactJson.length / 1e6).toFixed(2)} MB, ` +
    `${Object.keys(schemas.operations).length} operations, ${Object.keys(schemas.defs).length} defs`
)
start = performance.now()
const loaded = JSON.parse(artifactJson) as ResponseSchemas
console.log(`parse: ${ms(start)} (once per isolate per hour)\n`)

type Node = Record<string, unknown>

/** A value matching `schema`, with `items` entries for the top-level `result` array. */
function sample(schema: JsonSchema, items: number, depth = 0): unknown {
  if (typeof schema === 'boolean' || depth > 12) return {}
  const node = schema as Node
  if (typeof node.$ref === 'string') {
    const name = decodePointerToken(node.$ref.slice(DEFS_PREFIX.length))
    return sample(loaded.defs[name] ?? true, items, depth + 1)
  }
  if (Array.isArray(node.enum)) return node.enum.find((value) => value !== null) ?? null
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = node[keyword] as JsonSchema[] | undefined
    if (branches) {
      const branch =
        branches.find((b) => typeof b !== 'object' || (b as Node).type !== 'null') ?? true
      return sample(branch, items, depth + 1)
    }
  }
  if (Array.isArray(node.allOf)) {
    const parts = (node.allOf as JsonSchema[]).map((part) => sample(part, items, depth + 1))
    return parts.every((part) => typeof part === 'object' && part !== null && !Array.isArray(part))
      ? Object.assign({}, ...parts)
      : parts[0]
  }
  const type = Array.isArray(node.type)
    ? (node.type as string[]).find((t) => t !== 'null')
    : (node.type as string | undefined)
  if (type === 'array' || (!type && node.items)) {
    const count = depth <= 3 ? items : 2
    return Array.from({ length: count }, () =>
      sample((node.items as JsonSchema) ?? true, items, depth + 1)
    )
  }
  if (type === 'object' || (!type && node.properties)) {
    const properties = (node.properties ?? {}) as Record<string, JsonSchema>
    return Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [name, sample(value, items, depth + 1)])
    )
  }
  if (type === 'integer') return Math.max(1, Number(node.minimum ?? 1))
  if (type === 'number') return Math.max(1.5, Number(node.minimum ?? 1.5))
  if (type === 'boolean') return true
  if (type === 'null') return null
  return stringFor(node)
}

function stringFor(node: Node): string {
  switch (node.format) {
    case 'date-time':
      return '2026-01-01T00:00:00Z'
    case 'date':
      return '2026-01-01'
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000'
    case 'email':
      return 'user@example.com'
    case 'uri':
      return 'https://example.com/'
    case 'ipv4':
      return '192.0.2.1'
    case 'ipv6':
      return '2001:db8::1'
    case 'hostname':
      return 'example.com'
  }
  const min = Number(node.minLength ?? 0)
  return 'x'.repeat(Math.max(min, Math.min(32, Number(node.maxLength ?? 32))))
}

/** Break every array item: turn each string into a number. */
function breakTypes(value: unknown): unknown {
  if (typeof value === 'string') return 12345
  if (Array.isArray(value)) return value.map(breakTypes)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, breakTypes(v)]))
  }
  return value
}

function time(run: () => void, runs: number): number {
  const begin = performance.now()
  for (let i = 0; i < runs; i++) run()
  return (performance.now() - begin) / runs
}

function ms(begin: number): string {
  return `${(performance.now() - begin).toFixed(1)} ms`
}

const reachable = (key: string) =>
  JSON.stringify(loaded.operations[key]?.responses['200'] ?? '').length

// The operations agents call most, plus the one with the largest schema.
const largest = Object.keys(loaded.operations).sort((a, b) => reachable(b) - reachable(a))[0]
const operations = [
  'GET /zones',
  'GET /zones/{zone_id}/dns_records',
  'GET /accounts/{account_id}/workers/scripts',
  'GET /accounts/{account_id}/rulesets/{ruleset_id}',
  largest
].filter((key, i, all) => loaded.operations[key] && all.indexOf(key) === i)

const rows: string[][] = []
for (const key of operations) {
  const [method, pathTemplate] = key.split(' ')
  for (const items of [10, 100, 1000, 5000]) {
    const body = sample(loaded.operations[key].responses['200'] ?? true, items)
    const broken = breakTypes(body)
    const chars = JSON.stringify(body).length
    const check = (b: unknown) =>
      findMismatch(loaded, { method, pathTemplate, status: 200, body: b })

    let compileMs = ''
    if (items === 10) {
      const begin = performance.now()
      check(body)
      compileMs = (performance.now() - begin).toFixed(1)
    }
    const runs = chars > 500_000 ? 3 : 20
    const validMs = time(() => check(body), runs)
    const mismatch = check(body)
    const brokenMs = time(() => check(broken), runs)
    const brokenResult = check(broken)
    rows.push([
      key,
      String(items),
      `${(chars / 1024).toFixed(0)} KB`,
      compileMs,
      validMs.toFixed(2),
      mismatch ? `${mismatch.errorCount} (${mismatch.errors[0]?.keyword})` : '0',
      brokenMs.toFixed(2),
      `${brokenResult?.errorCount ?? 0}${brokenResult && !brokenResult.counted ? '+' : ''}`
    ])
  }
}

console.log(
  '| operation | items | body | compile ms | validate ms | errors | broken body ms | broken errors |'
)
console.log('|---|---|---|---|---|---|---|---|')
for (const row of rows) console.log(`| ${row.join(' | ')} |`)
