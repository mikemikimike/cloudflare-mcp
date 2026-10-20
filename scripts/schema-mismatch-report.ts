/**
 * Report where Cloudflare API responses don't match their OpenAPI response
 * schemas, grouped by product → operation → violation, from the
 * `response_schema_mismatch` events the direct tools write to Analytics Engine
 * (layout in `src/metrics.ts`). This is the list to send each product team.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
 *     npx tsx scripts/schema-mismatch-report.ts [--env production|staging|dev]
 *       [--days 7] [--product dns_records] [--server cloudflare-api]
 *       [--format markdown|json|sql]
 *
 * The token needs Account Analytics Read on the account that owns the
 * `mcp-metrics-*` datasets. `--format sql` prints the query without running it.
 * Read-only: it runs one SELECT.
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'

const DATASETS = {
  production: 'mcp-metrics-production',
  staging: 'mcp-metrics-staging',
  dev: 'mcp-metrics-dev'
} as const

const { values: args } = parseArgs({
  options: {
    env: { type: 'string', default: 'production' },
    days: { type: 'string', default: '7' },
    product: { type: 'string' },
    server: { type: 'string', default: 'cloudflare-api' },
    format: { type: 'string', default: 'markdown' }
  }
})

const dataset = DATASETS[args.env as keyof typeof DATASETS]
if (!dataset) fail(`--env must be one of ${Object.keys(DATASETS).join(', ')}`)
const days = Number(args.days)
if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days must be a whole number, 1-90')
if (!/^[\w.-]+$/.test(args.server)) fail('--server must be a plain server name')
if (!['markdown', 'json', 'sql'].includes(args.format))
  fail('--format must be markdown, json or sql')

// Counts are weighted by Analytics Engine's sampling and by our own
// RESPONSE_VALIDATION_SAMPLE_RATE (double4 = 1 / rate).
const SQL = `SELECT
  blob7 AS product,
  blob8 AS tag,
  blob5 AS method,
  blob6 AS path,
  blob9 AS response,
  blob10 AS keyword,
  blob11 AS schema_location,
  blob12 AS instance_path,
  SUM(_sample_interval * double4) AS responses,
  SUM(_sample_interval * double4 * double3) AS violations,
  MIN(double5) AS fully_counted,
  MAX(timestamp) AS last_seen
FROM '${dataset}'
WHERE index1 = 'response_schema_mismatch'
  AND blob1 = '${args.server}'
  AND timestamp > NOW() - INTERVAL '${days}' DAY
GROUP BY product, tag, method, path, response, keyword, schema_location, instance_path
ORDER BY product ASC, responses DESC
LIMIT 10000
FORMAT JSON`

if (args.format === 'sql') {
  console.log(SQL)
  process.exit(0)
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!accountId || !token) fail('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')

const Row = z.object({
  product: z.string(),
  tag: z.string().nullable().optional(),
  method: z.string(),
  path: z.string(),
  response: z.string(),
  keyword: z.string(),
  schema_location: z.string(),
  instance_path: z.string(),
  responses: z.coerce.number(),
  violations: z.coerce.number(),
  fully_counted: z.coerce.number(),
  last_seen: z.string()
})
type Row = z.infer<typeof Row>

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
  { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: SQL }
)
const text = await response.text()
if (!response.ok) fail(`Analytics Engine SQL API returned ${response.status}: ${text}`)
const rows = z
  .object({ data: z.array(Row) })
  .parse(JSON.parse(text))
  .data.filter((row) => !args.product || row.product === args.product)

if (args.format === 'json') {
  console.log(JSON.stringify(rows, null, 2))
} else {
  console.log(markdown(rows))
}

function markdown(rows: Row[]): string {
  const lines = [
    `# Response schema mismatches`,
    '',
    `\`${dataset}\`, server \`${args.server}\`, last ${days} days. Each row is one way a ` +
      'response broke its OpenAPI schema: the keyword that failed, where it is in the spec, and ' +
      'where in the response (`*` is an array index or a map key). "Responses" counts responses ' +
      'with this as their first violation; "violations" counts every violation in them (`≥` when ' +
      'large responses were only partly checked).',
    ''
  ]
  if (rows.length === 0) return [...lines, 'No mismatches recorded.'].join('\n')

  for (const [product, productRows] of groupBy(rows, (row) => row.product)) {
    const tags = [...new Set(productRows.map((row) => row.tag).filter(Boolean))].join(', ')
    const total = sum(productRows, (row) => row.responses)
    lines.push(`## ${product}${tags ? ` (${tags})` : ''}: ${round(total)} responses`, '')

    for (const [operation, operationRows] of groupBy(
      productRows,
      (row) => `${row.method} ${row.path}`
    )) {
      lines.push(`### \`${operation}\``, '')
      lines.push(
        '| response | keyword | schema location | instance path | responses | violations | last seen |'
      )
      lines.push('|---|---|---|---|---|---|---|')
      for (const row of operationRows) {
        const violations = `${row.fully_counted < 1 ? '≥' : ''}${round(row.violations)}`
        lines.push(
          `| ${row.response} | ${row.keyword} | \`${row.schema_location}\` | \`${row.instance_path}\` | ${round(row.responses)} | ${violations} | ${row.last_seen} |`
        )
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/** Group rows, keeping the query's order (busiest first within a product). */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(key(item)) ?? []
    group.push(item)
    groups.set(key(item), group)
  }
  return groups
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0)
}

function round(value: number): string {
  return String(Math.round(value))
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
