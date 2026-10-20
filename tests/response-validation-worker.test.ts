import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, mcpToolCallRequest, parseMcpResult, toolText } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'
import { resetIsolateCache } from '../src/isolate-cache'
import { RESPONSE_SCHEMAS_KEY } from '../src/response-schemas'
import { truncateResponse } from '../src/truncate'
import type { OperationInfo } from '../src/openapi'

/**
 * Response schema checks through the real worker at /mcp?codemode=false. The
 * Cloudflare API is the only mocked boundary (MSW). Checks run in `waitUntil`
 * after the result is built, so tests wait for the datapoint.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const TOKEN = 'acct-token-response-validation'
const SCRIPTS_URL = `${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`
const SECRET = 'customer-secret-value'

const SPEC_PATHS = {
  '/accounts/{account_id}/workers/scripts': {
    get: {
      summary: 'List Workers',
      tags: ['Worker Script'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/script-list' } }
          }
        },
        '4XX': {
          description: 'Failure',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/failure' } } }
        }
      }
    }
  }
} as unknown as Record<string, Record<string, OperationInfo>>

const COMPONENTS = {
  schemas: {
    'script-list': {
      type: 'object',
      required: ['success', 'result'],
      properties: {
        success: { type: 'boolean' },
        result: { type: 'array', items: { $ref: '#/components/schemas/script' } }
      }
    },
    script: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, etag: { type: 'string' } }
    },
    failure: {
      type: 'object',
      required: ['success', 'errors'],
      properties: {
        success: { type: 'boolean', enum: [false] },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: { type: 'integer' }, message: { type: 'string' } }
          }
        }
      }
    }
  }
}

type DataPoint = { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }

function mismatches(spy: { mock: { calls: unknown[][] } }): DataPoint[] {
  return spy.mock.calls
    .map((args) => args[0] as DataPoint)
    .filter((dp) => dp?.indexes?.[0] === 'response_schema_mismatch')
}

async function callScripts() {
  const request = new Request(
    `${MCP_URL}?codemode=false`,
    mcpToolCallRequest(TOKEN, 'get_accounts_workers_scripts', {})
  )
  return parseMcpResult(await exports.default.fetch(request))
}

/** Background work has no handle; give it time to finish before asserting nothing happened. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

beforeEach(async () => {
  await seedSpec(SPEC_PATHS, ['workers'], COMPONENTS)
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('direct-tool response schema checks', () => {
  it('records one mismatch and leaves the tool result unchanged', async () => {
    const body = cfSuccess([{ id: 42, etag: SECRET }, { etag: SECRET }])
    server.use(http.get(SCRIPTS_URL, () => HttpResponse.json(body)))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await callScripts()

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toBe(truncateResponse(body))
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    expect(mismatches(writeSpy)[0]).toEqual({
      indexes: ['response_schema_mismatch'],
      blobs: [
        'cloudflare-api',
        expect.any(String),
        null, // account token: no user
        'get_accounts_workers_scripts',
        'GET',
        '/accounts/{account_id}/workers/scripts',
        'workers',
        'Worker Script',
        '200',
        'type',
        '#/components/schemas/script/properties/id/type',
        '/result/*/id'
      ],
      doubles: [0, 200, 2, 1, 1]
    })

    const logged = warnSpy.mock.calls.map((args) => String(args[0]))
    const line = logged.find((text) => text.includes('response_schema_mismatch'))
    expect(JSON.parse(line!)).toMatchObject({
      message: 'response_schema_mismatch',
      toolName: 'get_accounts_workers_scripts',
      errorCount: 2,
      errors: [
        { keyword: 'type', instancePath: '/result/*/id' },
        { keyword: 'required', instancePath: '/result/*/id' }
      ]
    })
    // Neither the datapoint nor the log line carries response values.
    expect(JSON.stringify(writeSpy.mock.calls)).not.toContain(SECRET)
    expect(logged.join('\n')).not.toContain(SECRET)
    expect(logged.join('\n')).not.toContain('42')
  })

  it('checks error responses against their own schema', async () => {
    const body = { success: false, errors: [{ code: '10000', message: 'Authentication error' }] }
    server.use(http.get(SCRIPTS_URL, () => HttpResponse.json(body, { status: 403 })))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await callScripts()

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('returned HTTP 403')
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    const [dp] = mismatches(writeSpy)
    expect(dp.blobs?.slice(8)).toEqual([
      '4XX',
      'type',
      '#/components/schemas/failure/properties/errors/items/properties/code/type',
      '/errors/*/code'
    ])
    expect(dp.doubles?.[1]).toBe(403)
  })

  it('records nothing for a response that matches', async () => {
    server.use(http.get(SCRIPTS_URL, () => HttpResponse.json(cfSuccess([{ id: 'worker-a' }]))))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    const result = await callScripts()
    await settle()

    expect(toolText(result)).toContain('worker-a')
    expect(mismatches(writeSpy)).toHaveLength(0)
  })

  it('serves the tool result when the schemas artifact is broken or missing', async () => {
    server.use(http.get(SCRIPTS_URL, () => HttpResponse.json(cfSuccess([{ id: 7 }]))))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await env.SPEC_BUCKET.put(RESPONSE_SCHEMAS_KEY, '{not json')
    resetIsolateCache()
    const broken = await callScripts()
    await vi.waitFor(() =>
      expect(warnSpy.mock.calls.map(String).join()).toContain('response_validation_failed')
    )

    await env.SPEC_BUCKET.delete(RESPONSE_SCHEMAS_KEY)
    resetIsolateCache()
    const missing = await callScripts()
    await settle()

    for (const result of [broken, missing]) {
      expect(result.result?.isError).toBeFalsy()
      expect(toolText(result)).toBe(truncateResponse(cfSuccess([{ id: 7 }])))
    }
    expect(mismatches(writeSpy)).toHaveLength(0)
  })

  it('serves the tool result when recording the mismatch fails', async () => {
    server.use(http.get(SCRIPTS_URL, () => HttpResponse.json(cfSuccess([{ id: 7 }]))))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint').mockImplementation(() => {
      throw new Error('Analytics Engine down')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await callScripts()

    expect(toolText(result)).toBe(truncateResponse(cfSuccess([{ id: 7 }])))
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
  })
})
