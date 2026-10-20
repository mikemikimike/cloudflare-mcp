import { z } from 'zod'
import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { CLOUDFLARE_TYPES } from '../constants'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { formatError } from '../utils/errors'
import {
  ACCOUNT_DISCOVERY_DESCRIPTION,
  ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import { isCatalogScope, type Connection, type UntrustedEmptyList } from '../api-permissions'
import {
  explainEmptyListRequest,
  explainRefusedRequest,
  MISSING_SCOPE_HEADER,
  REFUSAL_HINT_HEADER
} from '../api-refusal-hint'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'

interface CodeExecutorEntrypoint {
  evaluate(): Promise<unknown>
}

/** What the sandbox reports about every run, whether the code returned or threw. */
const RunReport = z.object({
  // Paths of GETs whose list came back empty, which Cloudflare may have filtered by permission.
  emptyReads: z.array(z.string()),
  // Whether every request the code sent was a read or was refused, so rerunning repeats no change.
  replaySafe: z.boolean()
})

/** What the sandbox reports back. It is untrusted, so it is parsed. */
const Evaluation = z.union([
  RunReport.extend({ ok: z.literal(true), result: z.unknown() }),
  RunReport.extend({
    ok: z.literal(false),
    message: z.string(),
    // The OAuth scope GlobalOutbound said the failing request lacked.
    missingScope: z.string().optional()
  })
])

/** The outcome of running the agent's code. */
type Execution = z.infer<typeof Evaluation>

type GlobalOutboundProps = {
  apiToken: string
  fetchWithRetryCaller: string
  connection: Connection
}

/**
 * Outbound fetch proxy for the `execute` isolate: restricts dynamically-loaded
 * worker code to the configured Cloudflare API base URL and injects the API
 * token from props (so it never enters the user code isolate).
 *
 * Bound as the `GLOBAL_OUTBOUND` worker-loader entrypoint in wrangler.jsonc and
 * passed to `LOADER.get(..).globalOutbound` below. Wrangler resolves the
 * entrypoint from the worker's entry module, so index.ts re-exports this class.
 */
export class GlobalOutbound extends WorkerEntrypoint<Env, GlobalOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const allowed = new URL(this.env.CLOUDFLARE_API_BASE).hostname
    const requested = new URL(request.url).hostname
    if (requested !== allowed) {
      return new Response(`Forbidden: requests to ${requested} are not allowed`, { status: 403 })
    }
    // Inject auth header — token comes from props, never enters user code isolate
    const authedRequest = new Request(request, {
      headers: new Headers([
        ...request.headers.entries(),
        ['Authorization', `Bearer ${this.ctx.props.apiToken}`]
      ])
    })
    const response = await fetchWithRetry(authedRequest, undefined, {
      caller: this.ctx.props.fetchWithRetryCaller
    })

    // Cloudflare's 401/403 bodies don't say why. Attach an explanation the
    // sandbox puts in the error it throws, so it survives the code catching it.
    const basePath = new URL(this.env.CLOUDFLARE_API_BASE).pathname.replace(/\/$/, '')
    const refusal = await explainRefusedRequest(
      response.status,
      this.ctx.props.connection,
      request.method,
      new URL(request.url).pathname.slice(basePath.length)
    )
    if (!refusal) return response
    const headers = new Headers(response.headers)
    headers.set(REFUSAL_HINT_HEADER, encodeURIComponent(refusal.hint))
    if (refusal.scope) headers.set(MISSING_SCOPE_HEADER, refusal.scope)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }
}

/**
 * Run sandboxed JavaScript against the Cloudflare API via `cloudflare.request()`.
 *
 * A fresh isolate is created per call: the user code is baked into the module
 * source (dynamic-worker isolates disallow eval, so code cannot be passed into
 * a warm isolate), and the API token is injected via the GlobalOutbound props
 * so it never enters the user code isolate.
 */
async function runExecute(
  code: string,
  accountId: string | undefined,
  apiToken: string,
  unresolvedAccountMessage: string,
  connection: Connection
): Promise<Execution> {
  const apiBase = env.CLOUDFLARE_API_BASE
  const workerId = `cloudflare-api-${crypto.randomUUID()}`

  // When no account is resolved (a multi-account user who hasn't chosen one),
  // don't bind a usable `accountId`. Account-independent calls (GET /accounts,
  // GET /user) never touch it, but any code that reads it fails fast with a
  // clear message instead of silently producing `/accounts//...` (a 404).
  const accountIdPrelude = accountId
    ? `const accountId = ${JSON.stringify(accountId)};`
    : `Object.defineProperty(globalThis, "accountId", { configurable: true, get() {
        throw new Error(${JSON.stringify(unresolvedAccountMessage)});
      } });`

  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: exports.GlobalOutbound({
      props: { apiToken, fetchWithRetryCaller: 'codemode_execute_tool_call', connection }
    }),
    mainModule: 'worker.js',
    modules: {
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};
${accountIdPrelude}

// Every request the code sends, and the status it got. Replaying the code after a
// step-up is safe only if each one was a read or was refused.
const sentRequests = [];
// GET paths whose list came back empty. The host checks whether the connection
// could see anything there, since Cloudflare filters some lists instead of refusing.
const emptyReads = new Set();
const outboundFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const sent = { method: request.method.toUpperCase(), status: undefined };
  sentRequests.push(sent);
  const response = await outboundFetch(request);
  sent.status = response.status;
  return response;
};

// "Cloudflare API error: GET /zones/x/dns_records returned HTTP 403: 10000: Authentication error",
// plus the server's explanation of a 401/403.
function apiError(method, path, response, details) {
  const hint = response.headers.get(${JSON.stringify(REFUSAL_HINT_HEADER)});
  const error = new Error("Cloudflare API error: " + String(method).toUpperCase() + " " + path.split("?")[0] +
    " returned HTTP " + response.status + (details ? ": " + details.replace(/[. ]+$/, "") : "") +
    (hint ? ". " + decodeURIComponent(hint) : ""));
  const missingScope = response.headers.get(${JSON.stringify(MISSING_SCOPE_HEADER)});
  if (missingScope) error.missingScope = missingScope;
  return error;
}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    const cloudflare = {
      async request(options) {
        const { method, path, query, body, contentType, rawBody } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const headers = {};

        if (contentType) {
          headers["Content-Type"] = contentType;
        } else if (body && !rawBody) {
          headers["Content-Type"] = "application/json";
        }

        let requestBody;
        if (rawBody) {
          requestBody = body;
        } else if (body) {
          requestBody = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: requestBody,
        });

        const responseContentType = (response.headers.get("content-type") || "")
          .split(';', 1)[0].trim().toLowerCase();
        const isJson = responseContentType === "application/json"
          || responseContentType.endsWith("+json");

        // Handle non-JSON responses (e.g., KV values)
        if (!isJson) {
          const text = await response.text();
          if (!response.ok) {
            throw apiError(method, path, response, text.slice(0, 500));
          }
          return { success: true, status: response.status, result: text };
        }

        const data = await response.json();

        // Handle GraphQL responses (different format than REST)
        const cleanPath = path.split('?')[0].replace(/\\/+$/, '');
        const isGraphQLEndpoint = cleanPath === '/graphql' || cleanPath.endsWith('/graphql');

        if (isGraphQLEndpoint) {
          const graphqlErrors = Array.isArray(data.errors) ? data.errors : [];
          const hasData = data.data !== null && data.data !== undefined;

          // Complete failure: no data, only errors
          if (graphqlErrors.length > 0 && !hasData) {
            const msgs = graphqlErrors.map(e => e.message).join(", ");
            throw new Error("GraphQL error: " + msgs);
          }

          // Success or partial success
          return {
            success: graphqlErrors.length === 0,
            status: response.status,
            result: data.data,
            errors: graphqlErrors.map(e => ({
              code: e.extensions?.code || 0,
              message: e.message + (e.path ? \` (at \${e.path.join('.')})\` : '')
            })),
            messages: graphqlErrors.length > 0 ? [{
              code: 0,
              message: \`Partial response: \${graphqlErrors.length} error(s)\`
            }] : []
          };
        }

        // Some APIs (e.g., SQL and SCIM) return JSON without the REST envelope.
        const isEnvelope = data !== null && typeof data === "object"
          && !Array.isArray(data) && typeof data.success === "boolean";
        if (!response.ok || (isEnvelope && !data.success)) {
          const errorList = Array.isArray(data?.errors) ? data.errors : [];
          const errors = errorList.map(e => (e.code === undefined ? "" : e.code + ": ") + e.message +
            (e.documentation_url ? " (" + e.documentation_url + ")" : "")).join(", ");
          throw apiError(method, path, response, errors);
        }

        const payload = isEnvelope
          ? { ...data, status: response.status }
          : { success: true, status: response.status, result: data };
        if (String(method).toUpperCase() === "GET" && Array.isArray(payload.result)
            && payload.result.length === 0) {
          emptyReads.add(path.split("?")[0]);
        }
        return payload;
      }
    };

    const report = () => ({
      emptyReads: [...emptyReads],
      replaySafe: sentRequests.every(({ method, status }) =>
        method === "GET" || method === "HEAD" || status === 401 || status === 403)
    });
    try {
      const result = await (${code})();
      return { ok: true, result, ...report() };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        missingScope: typeof err?.missingScope === "string" ? err.missingScope : undefined,
        ...report()
      };
    }
  }
}
      `
    }
  }))

  const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint
  const evaluation = Evaluation.safeParse(await entrypoint.evaluate())
  if (!evaluation.success) throw new Error('The code sandbox returned an unreadable result')
  return evaluation.data
}

const UNSAFE_TO_REPLAY =
  'This program sent requests that may already have changed resources, so it is not offered for an automatic retry. After the scope is granted, run only the steps that still need it.'

/** Empty-list explanations looked up per program, at most. Each is one catalog match. */
const MAX_EMPTY_READS = 20

/**
 * The scope to step up for when the code failed on a request refused for it.
 *
 * The sandbox reports the scope, so it is untrusted: it must be a catalog
 * scope the connection lacks. Code that lies can only ask for a scope it could
 * also get challenged for by calling an endpoint that needs it.
 */
function challengeableScope(execution: Execution, connection: Connection): string | undefined {
  if (execution.ok || connection.kind !== 'oauth' || !execution.missingScope) return undefined
  const scope = execution.missingScope
  return isCatalogScope(scope) && !connection.scopes.includes(scope) ? scope : undefined
}

/**
 * Explain the empty lists the code got from reads the connection holds no
 * accepted scope for. Distinct explanations, in the order the reads were sent.
 */
async function untrustedEmptyLists(
  execution: Execution,
  connection: Connection
): Promise<UntrustedEmptyList[]> {
  if (connection.kind !== 'oauth') return []
  const paths = [...new Set(execution.emptyReads)].slice(0, MAX_EMPTY_READS)
  const explained = await Promise.all(
    paths.map((path) => explainEmptyListRequest(connection, path))
  )
  const byHint = new Map<string, UntrustedEmptyList>()
  for (const entry of explained) if (entry) byHint.set(entry.hint, entry)
  return [...byHint.values()]
}

/**
 * Description for the `execute` tool: the Cloudflare type declarations, how
 * `accountId` is resolved, and a multipart Worker-upload example.
 *
 * It is the same for every session. MCP clients cache tool metadata and may
 * serve one user's tool list to another, so nothing here may depend on the
 * token: no account ids or names, and no branching on token shape.
 */
const EXECUTE_TOOL_DESCRIPTION = `Execute JavaScript code that can read, create, update, or delete resources through the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${CLOUDFLARE_TYPES}
// accountId is the account_id tool argument when passed; otherwise the session's account when it is authorized for exactly one. Reading it when neither applies throws an error.

When the session has access to multiple accounts, pass account_id. ${ACCOUNT_DISCOVERY_DESCRIPTION}

Your code must be an async arrow function that returns the result.
A failed request throws an Error naming the method, path, HTTP status and Cloudflare's errors. For HTTP 401/403 it also says which permission the endpoint needs and whether reconnecting will help.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = \`addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));\`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = \`--F\${Date.now()}\`;
  const body = [\`--\${b}\`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), \`--\${b}\`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, \`--\${b}--\`].join("\\r\\n");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
}`

/** Add paragraphs to a tool result's text. */
function appendNotes(result: CallToolResult, notes: readonly string[]): void {
  const text = notes.filter(Boolean).join('\n\n')
  const [first] = result.content
  if (text && first?.type === 'text') first.text += `\n\n${text}`
}

const ACCOUNT_ID_PARAM_DESCRIPTION =
  'Cloudflare account ID to run against. Optional when the session is authorized for exactly one account, and for account-independent calls such as GET /accounts.'

/**
 * Register the `execute` tool: runs sandboxed JavaScript against the Cloudflare
 * API via `cloudflare.request()`.
 *
 * The metadata is identical for every token (see `EXECUTE_TOOL_DESCRIPTION`);
 * only the handler looks at the session. An explicit `account_id` wins,
 * otherwise the account is auto-resolved for account tokens and single-account
 * user tokens. An account token given another account's id is rejected by the
 * Cloudflare API, the same as any other account it can't access.
 *
 * `formatResult` turns the value the code returns into the tool's text output.
 */
export function registerExecuteTool(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): void {
  const apiToken = props.accessToken

  server.registerTool(
    'execute',
    {
      title: 'Cloudflare API Code Executor',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: z.object({
        code: z.string().describe('JavaScript async arrow function to execute'),
        account_id: z.string().optional().describe(ACCOUNT_ID_PARAM_DESCRIPTION)
      }),
      annotations: {
        title: 'Cloudflare API Code Executor',
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true
      }
    },
    async ({ code, account_id }) => {
      try {
        // Undefined accountId lets account-independent requests such as
        // GET /accounts run before the caller has selected an account; any
        // code that reads `accountId` then fails fast with a clear message.
        const effectiveAccountId = account_id || autoResolvedAccountId(props)

        const execution = await runExecute(
          code,
          effectiveAccountId,
          apiToken,
          missingAccountMessage(props, ACCOUNT_DISCOVERY_GUIDANCE),
          connection
        )
        // An empty list from a read the connection holds no accepted scope for may
        // be Cloudflare filtering, not an empty account. Say so even when the code
        // only returned a count, and step up as for a refusal.
        const emptyLists = await untrustedEmptyLists(execution, connection)
        const result: CallToolResult = execution.ok
          ? { content: [{ type: 'text', text: formatResult(execution.result) }] }
          : formatError(execution.message)
        const notes = emptyLists.map(({ hint }) => hint)
        if (!execution.ok && account_id) notes.push(unknownAccountHint(props, account_id))

        // A refusal that made the code fail comes first; otherwise the first empty
        // list whose scope can be named (code reading `result[0]` fails on one, too).
        const scope =
          challengeableScope(execution, connection) ??
          emptyLists.find((entry) => entry.scope)?.scope
        if (scope && !execution.replaySafe) notes.push(UNSAFE_TO_REPLAY)
        appendNotes(result, notes)
        if (!scope || !execution.replaySafe) return result

        const challenge = scopeChallenge.require(scope)
        return challenge
          ? { ...result, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } }
          : result
      } catch (error) {
        const failure = formatError(error)
        const hint = account_id ? unknownAccountHint(props, account_id) : ''
        if (hint) failure.content[0].text += `\n\n${hint}`
        return failure
      }
    }
  )
}
