import { env, waitUntil } from 'cloudflare:workers'
import type { AuthProps } from './auth/types'
import { getResponseSchemas } from './isolate-cache'
import { recordResponseSchemaMismatch } from './metrics'
import { findMismatch, type MismatchError, type ResponseToCheck } from './response-schema-check'

/**
 * Checks direct-tool responses against the operation's OpenAPI response schema
 * and records each mismatch, so product teams can fix their schemas before
 * tools advertise an `outputSchema`.
 *
 * Nothing here may change or fail a tool result: `checkResponse` returns
 * immediately, the work runs in `waitUntil` after the result is built, and every
 * error is caught. Nothing recorded or logged contains response values, which
 * are customer data: only schema locations, keywords, and instance paths whose
 * segments are array wildcards or property names declared by the schema.
 */

/**
 * Bodies larger than this are not checked. Arrays are trimmed before
 * validation, so this only bounds the cost of very large objects and maps.
 */
export const MAX_BODY_CHARS = 1_000_000
/** Longest string written to one Analytics Engine blob. */
const MAX_BLOB_CHARS = 512

export interface ResponseCheck extends ResponseToCheck {
  /** The MCP tool that made the request. */
  toolName: string
  /** Length of the raw body text. */
  bodyChars: number
  props: AuthProps
}

/**
 * Check a direct-tool response against its schema in the background and record
 * any mismatch. Call it for JSON responses only, with the parsed body. Shared
 * by every direct-tools server. Never throws.
 */
export function checkResponse(check: ResponseCheck): void {
  try {
    const sampleRate = sampleRateFrom(env.RESPONSE_VALIDATION_SAMPLE_RATE)
    if (sampleRate <= 0 || Math.random() >= sampleRate) return
    if (check.bodyChars > MAX_BODY_CHARS) return
    waitUntil(run(check, sampleRate))
  } catch (error) {
    logFailure(check, error)
  }
}

async function run(check: ResponseCheck, sampleRate: number): Promise<void> {
  try {
    // Yield a macrotask so the tool result is serialized and sent first.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const schemas = await getResponseSchemas()
    if (!schemas) return
    const mismatch = findMismatch(schemas, check)
    if (!mismatch) return
    const { errors, ...summary } = mismatch
    const event = {
      toolName: check.toolName,
      method: check.method.toUpperCase(),
      pathTemplate: check.pathTemplate,
      status: check.status,
      sampleInterval: 1 / sampleRate,
      ...summary
    }
    recordResponseSchemaMismatch(check.props, { ...event, first: clipError(errors[0]) })
    console.warn(JSON.stringify({ message: 'response_schema_mismatch', ...event, errors }))
  } catch (error) {
    logFailure(check, error)
  }
}

/** `RESPONSE_VALIDATION_SAMPLE_RATE` as a fraction in [0, 1]. Unset or invalid means 1. */
export function sampleRateFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 1
  const rate = Number(value)
  if (!Number.isFinite(rate)) return 1
  return Math.min(1, Math.max(0, rate))
}

function clipError(error: MismatchError | undefined): MismatchError {
  return {
    keyword: (error?.keyword ?? '').slice(0, MAX_BLOB_CHARS),
    schemaLocation: (error?.schemaLocation ?? '').slice(0, MAX_BLOB_CHARS),
    instancePath: (error?.instancePath ?? '').slice(0, MAX_BLOB_CHARS)
  }
}

function logFailure(check: ResponseCheck, error: unknown): void {
  try {
    console.warn(
      JSON.stringify({
        message: 'response_validation_failed',
        toolName: check.toolName,
        method: check.method,
        pathTemplate: check.pathTemplate,
        status: check.status,
        // Validator and loader errors name schemas, never response values.
        error: String(error instanceof Error ? error.message : error).slice(0, 300)
      })
    )
  } catch {
    // Logging must not throw either.
  }
}
