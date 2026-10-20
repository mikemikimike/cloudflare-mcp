import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

/**
 * Cloudflare refuses some endpoints without the permission (D1 answers 403) but
 * filters others down to what the credential may see: `GET /zones` without
 * `zone.read` is `200` with an empty `result`. An empty list from a read the
 * connection holds no accepted scope for proves nothing, so it gets the same
 * step-up as a refusal (cloudflare/mcp#302). Driven through the real worker.
 */

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const DNS_PATH = `/zones/${ZONE_ID}/dns_records`
const BASELINE = ['user:read', 'account:read']
const RESOURCE_METADATA = 'https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp'
const EMPTY_LIST_HINT = 'GET /zones/{zone_id}/dns_records returned an empty list'

const GET_DNS = `async () => cloudflare.request({ method: "GET", path: "${DNS_PATH}" })`

beforeEach(async () => {
  await seedSpec(
    {
      '/zones/{zone_id}/dns_records': {
        get: {
          summary: 'List DNS Records',
          'x-api-token-group': ['DNS Read', 'DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        },
        post: {
          summary: 'Create DNS Record',
          'x-api-token-group': ['DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        }
      }
    },
    ['dns']
  )
  server.use(http.post(`${API_BASE}${DNS_PATH}`, () => HttpResponse.json(cfSuccess({ id: 'r1' }))))
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

function listDnsRecords(result: unknown[]): void {
  server.use(http.get(`${API_BASE}${DNS_PATH}`, () => HttpResponse.json(cfSuccess(result))))
}

function execute(token: string, code: string, query = ''): Promise<Response> {
  return exports.default.fetch(
    modernMcpRequest(
      token,
      'tools/call',
      { name: 'execute', arguments: { code } },
      { url: `${MCP_URL}${query}` }
    )
  )
}

function listDnsRecordsTool(token: string, query: string): Promise<Response> {
  return exports.default.fetch(
    modernMcpRequest(
      token,
      'tools/call',
      { name: 'get_zones_dns_records', arguments: { zone_id: ZONE_ID } },
      { url: `${MCP_URL}${query}` }
    )
  )
}

function expectChallenge(response: Response, scope: string): void {
  expect(response.status).toBe(403)
  const challenge = response.headers.get('WWW-Authenticate') ?? ''
  expect(challenge).toContain('error="insufficient_scope"')
  expect(challenge).toContain(`scope="${[...BASELINE, scope].join(' ')}"`)
  expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`)
}

describe('execute', () => {
  it('challenges for the scope, as Cloudflare refusing would', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    expectChallenge(await execute(token, GET_DNS), 'dns.read')
  })

  it('keeps the result, explains it and carries the challenge with scopeChallenge=tool', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    const response = await execute(token, GET_DNS, '?scopeChallenge=tool')
    const body = await parseMcpResult(response)
    const text = body.result?.content?.[0]?.text ?? ''

    expect(response.status).toBe(200)
    expect(body.result?.isError).toBeFalsy()
    expect(text).toContain('"result": []')
    expect(text).toContain(EMPTY_LIST_HINT)
    expect(text).toContain('grant `dns.read` (DNS Read)')
    const [challenge] = body.result?._meta?.['mcp/www_authenticate'] as string[]
    expect(challenge).toContain('scope="user:read account:read dns.read"')
  })

  it('explains it when the code returns only a count', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    const code = `async () => (await cloudflare.request({ method: "GET", path: "${DNS_PATH}" })).result.length`
    const text = (await parseMcpResult(await execute(token, code, '?scopeChallenge=tool'))).result
      ?.content?.[0]?.text

    expect(text).toContain('0')
    expect(text).toContain(EMPTY_LIST_HINT)
  })

  it('challenges when the code fails on the empty list', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    const code = `async () => (await cloudflare.request({ method: "GET", path: "${DNS_PATH}" })).result[0].id`
    expectChallenge(await execute(token, code), 'dns.read')
  })

  it('explains it but does not challenge after a write went through', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    const code = `async () => {
      await cloudflare.request({ method: "POST", path: "${DNS_PATH}", body: { type: "A" } })
      return cloudflare.request({ method: "GET", path: "${DNS_PATH}" })
    }`
    const response = await execute(token, code)
    const body = await parseMcpResult(response)
    const text = body.result?.content?.[0]?.text ?? ''

    expect(response.status).toBe(200)
    expect(text).toContain(EMPTY_LIST_HINT)
    expect(text).toContain('not offered for an automatic retry')
    expect(body.result?._meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('trusts an empty list when the connection holds an accepted scope', async () => {
    const token = await connectWithOAuth([...BASELINE, 'dns.read'])
    listDnsRecords([])

    const response = await execute(token, GET_DNS)

    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.content?.[0]?.text).not.toContain('empty list')
  })

  it('trusts a list with rows', async () => {
    // GET /accounts/{account_id}/members returns rows without memberships.read.
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([{ id: 'record' }])

    const response = await execute(token, GET_DNS)
    const text = (await parseMcpResult(response)).result?.content?.[0]?.text ?? ''

    expect(response.status).toBe(200)
    expect(text).toContain('record')
    expect(text).not.toContain('empty list')
  })

  it('says nothing for a direct API token, whose permissions are unknown', async () => {
    mockIdentityProbe({ accounts: [{ id: 'acc-1', name: 'Acc' }] })
    listDnsRecords([])

    const result = await callTool('cfat_direct', 'execute', { code: GET_DNS })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).not.toContain('empty list')
  })
})

describe('endpoint tools', () => {
  it('challenge for the scope', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    expectChallenge(await listDnsRecordsTool(token, '?codemode=false'), 'dns.read')
  })

  it('keep the result and explain it with scopeChallenge=tool', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([])

    const body = await parseMcpResult(
      await listDnsRecordsTool(token, '?codemode=false&scopeChallenge=tool')
    )
    const text = body.result?.content?.[0]?.text ?? ''

    expect(body.result?.isError).toBeFalsy()
    expect(text).toContain(EMPTY_LIST_HINT)
    expect(body.result?._meta?.['mcp/www_authenticate']).toHaveLength(1)
  })

  it('trust a list with rows', async () => {
    const token = await connectWithOAuth(BASELINE)
    listDnsRecords([{ id: 'record' }])

    const response = await listDnsRecordsTool(token, '?codemode=false')
    const text = (await parseMcpResult(response)).result?.content?.[0]?.text ?? ''

    expect(response.status).toBe(200)
    expect(text).toContain('record')
    expect(text).not.toContain('empty list')
  })
})
