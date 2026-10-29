// EdgePress MCP server core — transport-agnostic, zero dependencies.
//
// CANONICAL COPY. scripts/sync-plugins.sh copies this file verbatim into
// plugins/mcp-edgepress/src/mcp.js (the stdio server) and
// scripts/check-plugin-sync.mjs fails CI if the two differ. Edit it here.
//
// Two hosts drive it:
//   - dispatcher/src/index.js serves it at https://<tenant>/api/mcp over
//     Streamable HTTP, forwarding each call to the tenant Worker;
//   - plugins/mcp-edgepress/bin/edgepress-mcp.js serves it over stdio,
//     calling https://<tenant>/api/v1 over the network.
//
// The server holds no credential and makes no auth decision of its own: the
// caller's PAT rides along on every API call and the tenant's api-middleware
// decides, exactly as for a plain REST call. That is why the tools are one
// generic request plus a spec lookup — the MCP layer cannot drift from the
// API's authorization or its route table.

export const SERVER_INFO = { name: 'edgepress', version: '0.1.0' };

// Newest first. An unknown client version gets our newest; the client
// disconnects if it cannot speak it (spec: lifecycle / version negotiation).
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Tool output goes into the agent's context window; a full export would
// swamp it. List endpoints paginate, so the agent can always ask for less.
const MAX_TEXT = 200_000;

const SPEC_TTL_MS = 10 * 60 * 1000;
let specCache = null; // { at, value }

const INSTRUCTIONS = `You are connected to one EdgePress site (CMS or store) with the user's personal access token.
- ep_request calls the site's REST API under /api/v1. Your role and token mode (read_only or read_write) decide what is allowed; GET /users/me tells you both.
- The OpenAPI spec lists CMS routes as /api/<x> and store routes as /api/v1/<x>. Either way pass ep_request only the part after the prefix: /api/posts -> "/posts", /api/v1/products -> "/products".
- Use ep_api_spec to find a route and its request body before writing. A 403 means the token or role does not allow the call; tell the user rather than retrying.
- Multipart media upload is not supported through this server; use the admin UI for file uploads.`;

const TOOLS = [
  {
    name: 'ep_request',
    description: 'Call the EdgePress REST API (/api/v1) of the connected site. Returns the HTTP status and the JSON body.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Path under /api/v1 with optional query string, e.g. "/posts?limit=3", "/posts/42", "/users/me".' },
        body: { type: 'object', additionalProperties: true, description: 'JSON body for POST/PUT/PATCH.' },
      },
    },
  },
  {
    name: 'ep_api_spec',
    description: 'Look up the EdgePress OpenAPI spec. No arguments: an index of every route. search: routes whose path, summary or tag contains the text (full detail when 10 or fewer match). schema: one component schema by name, for resolving a $ref.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search: { type: 'string', description: 'Case-insensitive substring, e.g. "posts" or "discount".' },
        schema: { type: 'string', description: 'Name from #/components/schemas/<name>.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification / a client response (nothing to send back).
 *
 * host.api(method, pathAndQuery, body) -> Promise<{ status, body }>, where
 *   pathAndQuery is already confined to /api/v1/ (see apiPath).
 * host.loadSpec() -> Promise<object> — the parsed OpenAPI document.
 */
export async function handleMessage(msg, host) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid request (single JSON-RPC 2.0 message expected)');
  }
  if (msg.id === undefined || msg.id === null) return null; // notification
  if (typeof msg.method !== 'string') return null;           // a response to us; we never ask

  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case 'initialize': {
        // Fail at connect time, not on the first tool call: a client shows
        // "could not connect" for a bad token instead of a half-working server.
        const me = await host.api('GET', '/api/v1/users/me');
        if (me.status === 401 || me.status === 403) {
          return rpcError(id, -32001, `EdgePress rejected the access token (HTTP ${me.status}). Create one under Admin -> API tokens and send it as "Authorization: Bearer epat_...".`);
        }
        const asked = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call':
        return rpcResult(id, await callTool(params.name, params.arguments ?? {}, host));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    return rpcResult(id, toolText(`Error: ${err?.message ?? err}`, true));
  }
}

async function callTool(name, args, host) {
  if (name === 'ep_request') {
    const method = String(args.method ?? '').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return toolText(`Unsupported method: ${args.method}`, true);
    }
    const path = apiPath(args.path);
    if (!path) return toolText('path must start with "/" and stay under /api/v1, e.g. "/posts?limit=3".', true);
    const body = method === 'GET' || method === 'DELETE' ? undefined : args.body;
    const res = await host.api(method, path, body);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
    return toolText(`HTTP ${res.status}\n${text ?? ''}`, res.status >= 400);
  }
  if (name === 'ep_api_spec') {
    return toolText(specLookup(await cachedSpec(host), args));
  }
  throw new RpcError(-32602, `Unknown tool: ${name}`);
}

/**
 * Confine a caller-supplied path to /api/v1/. The URL parser resolves "..",
 * "%2e%2e" and friends exactly as the tenant's router will, so checking the
 * RESOLVED pathname is what keeps "/../internal/cron" from escaping.
 * Returns "/api/v1/...?query" or null.
 */
export function apiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  let u;
  try { u = new URL('/api/v1' + path, 'https://tenant.invalid'); } catch { return null; }
  if (u.origin !== 'https://tenant.invalid' || !u.pathname.startsWith('/api/v1/')) return null;
  return u.pathname + u.search;
}

async function cachedSpec(host) {
  if (!specCache || Date.now() - specCache.at > SPEC_TTL_MS) {
    specCache = { at: Date.now(), value: await host.loadSpec() };
  }
  return specCache.value;
}

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

export function specLookup(spec, { search, schema } = {}) {
  if (schema) {
    const s = spec.components?.schemas?.[schema];
    return s ? JSON.stringify(s, null, 2) : `No schema named "${schema}".`;
  }
  const needle = search ? String(search).toLowerCase() : null;
  const matches = Object.entries(spec.paths ?? {}).filter(([p, item]) => !needle
    || p.toLowerCase().includes(needle)
    || VERBS.some((v) => item[v] && [item[v].summary, ...(item[v].tags ?? [])]
      .some((t) => typeof t === 'string' && t.toLowerCase().includes(needle))));
  if (!matches.length) return `No route matches "${search}". Call ep_api_spec with no arguments for the full index.`;
  if (needle && matches.length <= 10) {
    return JSON.stringify(Object.fromEntries(matches), null, 2);
  }
  const lines = [];
  for (const [p, item] of matches) {
    for (const v of VERBS) {
      if (!item[v]) continue;
      const summary = item[v].summary && item[v].summary !== `${v.toUpperCase()} ${p}` ? ` — ${item[v].summary}` : '';
      lines.push(`${v.toUpperCase()} ${p}${summary}`);
    }
  }
  return `${lines.length} operations. Narrow with search for full request/response detail.\n${lines.join('\n')}`;
}

function toolText(text, isError = false) {
  const t = text.length > MAX_TEXT
    ? text.slice(0, MAX_TEXT) + `\n… truncated (${text.length} chars). Page or filter the request.`
    : text;
  return { content: [{ type: 'text', text: t }], isError };
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
