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

export const SERVER_INFO = { name: 'edgepress', version: '0.3.1' };

// Newest first. An unknown client version gets our newest; the client
// disconnects if it cannot speak it (spec: lifecycle / version negotiation).
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Tool output goes into the agent's context window; a full export would
// swamp it. List endpoints paginate, so the agent can always ask for less.
// 50k chars is ~12k tokens: one big template fits, a whole export does not.
const MAX_TEXT = 50_000;

const SPEC_TTL_MS = 10 * 60 * 1000;
let specCache = null; // { at, value }

const INSTRUCTIONS = `You are connected to one EdgePress site (CMS or store) with the user's personal access token.
- ep_request calls the site's REST API under /api/v1. Your role and token mode (read_only or read_write) decide what is allowed; GET /users/me tells you both, and which product the site is (cms or store).
- The OpenAPI spec lists CMS routes as /api/<x> and store routes as /api/v1/<x>. Either way pass ep_request only the part after the prefix: /api/posts -> "/posts", /api/v1/products -> "/products". ep_api_spec shows only the connected site's product by default.
- Use ep_api_spec to find a route and its request body before writing. A 403 means the token or role does not allow the call; tell the user rather than retrying. A 429 tells you how long to wait.
- Block types: on a CMS site GET /blocks lists them and GET /blocks/<type>/schema gives each one's config; on a store use /block-types and /block-types/<slug>/schema.
- Page structure on a CMS site: prefer the REST routes (/templates, /templates/<id>/zones, /templates/<id>/blocks, /blocks/<id>, PUT /pages/<id>/template) over POST /graphql, which answers HTTP 200 even on failure. REST PATCH /blocks/<id> merges config; GraphQL replaces it.
- The header menu is the navigation block's config.menuItems in the base layout template's header zone: GET /templates?isBaseLayout=true, GET /templates/<id>/blocks?zone=header, then PATCH /blocks/<blockId> {"config":{"menuItems":[…]}} with the complete list ({text, url, children?}); the site's categories are appended unless you also send "showCategories": false. PUT /pages/<id> is partial: send only the fields you change.
- Files: use ep_media_upload (from a URL or base64), never ep_request.
- To see a page as visitors get it — robots, title, headings, structured data, images, lang/dir — use ep_page_inspect. With page_id it also works for drafts, through a private noindex preview link (GET /pages/<id>/preview-url; give that url to the user to look at a draft).
- Prompts build-landing-page and qa-landing-page describe the safe end-to-end flows.`;

// ep_media_upload. The CMS caps images at 20MB; one cap for every type keeps the
// MCP body and the Worker's memory bounded. Video above it: use the admin UI.
const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_TYPES = /^(image\/[\w.+-]+|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/;

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
    name: 'ep_media_upload',
    description: 'Upload an image, video, audio file or PDF (max 20MB) from a public URL or base64. Default: into the CMS media library, published with the given alt text. With product_id: added to that store product\'s images.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source_url: { type: 'string', description: 'Public http(s) URL the server downloads the file from.' },
        base64: { type: 'string', description: 'File contents, base64. Needs filename (with extension) or content_type.' },
        filename: { type: 'string', description: 'Defaults to the last segment of source_url.' },
        content_type: { type: 'string', description: 'Overrides the detected type, e.g. "image/webp".' },
        alt_text: { type: 'string', description: 'Required for the media library: describes the image for screen readers.' },
        display_name: { type: 'string', description: 'Media library title. Defaults to the filename.' },
        caption: { type: 'string' },
        tag_ids: { type: 'array', items: { type: 'integer' }, description: 'Media tag ids.' },
        product_id: { type: 'integer', description: 'Store only: attach to this product instead of the media library.' },
      },
    },
  },
  {
    name: 'ep_page_inspect',
    description: 'Fetch a page of the connected site as a visitor gets it and report what matters for SEO and QA: HTTP status, robots (meta and X-Robots-Tag), title, description, canonical, lang/dir, headings, JSON-LD types, images missing alt or hot-linked, and in-page links to anchors that do not exist. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        page_id: { type: 'integer', description: 'CMS page id. Works for drafts too, through a private preview link (needs editor or admin).' },
        path: { type: 'string', description: 'Site path, e.g. "/", "/page/about", "/post/hello". Ignored when page_id is given.' },
      },
    },
    annotations: { readOnlyHint: true },
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
        product: { type: 'string', enum: ['cms', 'store', 'all'], description: 'Defaults to the connected site\'s product.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

// Built-in workflows. The build order and REST-vs-GraphQL rules come from the
// canonical skill (claude-code-edgepress/skills/edgepress/references/templates.md);
// change them together. The CMS has no private preview yet, so the build flow
// stops at a draft page and asks before anything becomes public.
const PROMPTS = [
  {
    name: 'build-landing-page',
    description: 'Build a landing page as a draft: new template, zones, blocks and uploaded images, a private preview and a check, then stop for review.',
    arguments: [
      { name: 'goal', description: 'What the page is for and what it should say.', required: true },
      { name: 'slug', description: 'URL slug for the page, e.g. "spring-sale".', required: false },
    ],
    text: ({ goal, slug }) => `Build a landing page on this EdgePress site. Goal: ${goal || '(ask the user)'}${slug ? `\nSlug: ${slug}` : ''}

Work in this order:
1. GET /users/me. Confirm the product, a role of editor or admin, and readOnly false. If not, stop and tell the user. If the product is "store", the template routes differ: find them with ep_api_spec, use /block-types for block schemas, and use POST /templates/<id>/preview-token for a private preview instead of publishing anything.
2. GET /blocks, then GET /blocks/<type>/schema for every type you will use. Put only schema fields in a config.
3. Upload each image with ep_media_upload, with real alt text, and use the returned url. Do not hot-link images from other sites.
4. Create a NEW template; never edit an existing or default one. POST /templates {"name":"…","type":"PAGE"}, then POST /templates/<id>/zones {"name":"Main","slug":"main","orderIndex":0}, then one POST /templates/<id>/blocks per block {"zoneSlug":"main","blockType":"…","config":{…}}. A 400 lists validationErrors: fix the named field, never retry unchanged.
5. Create the page as a draft (POST /pages with status "draft"; check the body with ep_api_spec search "/api/pages"). Set its "robots" field to "noindex, nofollow" unless the user wants it indexed. Then PUT /pages/<pageId>/template {"templateId":"<id>"} and POST /templates/<id>/publish.
6. Check it: ep_page_inspect with page_id renders the draft through a private noindex preview. Fix any missing alt text, extra h1, broken anchor or invalid JSON-LD it reports.
7. Report the template id, page id, blocks and media ids, and the preview link from GET /pages/<pageId>/preview-url so the user can look at it. Do NOT set the page to published: it becomes public immediately. Ask the user first.

Never change settings, the theme, or any template you did not create in this conversation.`,
  },
  {
    name: 'qa-landing-page',
    description: 'Review a page before it goes live — what visitors will get and what is stored. Read-only.',
    arguments: [{ name: 'page_id', description: 'The page to review.', required: true }],
    text: ({ page_id }) => `Review EdgePress page ${page_id || '(ask the user for the page id)'} before it goes live. Read only: change nothing.

1. GET /pages/${page_id || '<id>'}: title, slug, status and SEO fields. Flag an empty title or description, a title over 60 characters, a description over 160, and a robots value that does not match the user's intent.
2. Find the page's template and GET /templates/<templateId>: list its zones and blocks in order.
3. For each block type, GET /blocks/<type>/schema once and check every stored config against it: keys the schema does not define (stored but not rendered), missing required fields, empty headings or buttons, links to "#" or placeholder URLs.
4. Headings: one main heading for the page; flag a second hero or h1.
5. Run ep_page_inspect with page_id ${page_id || '<id>'}: it renders the page (a draft through a private preview) as visitors get it. Check: robots matches intent (a page meant to stay private must not be indexable), title and description present, exactly one h1, valid JSON-LD, lang/dir right for the content's language, no images missing alt or hot-linked, no broken anchors or placeholder links.
6. Report a short pass/fail list with the exact fix for each failure, and give the user the preview link (GET /pages/<id>/preview-url) to look at it themselves.`,
  },
];

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification / a client response (nothing to send back).
 *
 * host.api(method, pathAndQuery, body) -> Promise<{ status, body }>, where
 *   pathAndQuery is already confined to /api/v1/ (see apiPath).
 * host.loadSpec() -> Promise<object> — the parsed OpenAPI document.
 * host.fetchPage(pathAndQuery) -> Promise<{ status, headers, text }> — a page
 *   of the site as an anonymous visitor gets it: no credentials, no redirects
 *   followed.
 * host.origin — "https://<site>", what fetchPage paths are relative to.
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
          capabilities: { tools: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'prompts/list':
        return rpcResult(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
      case 'prompts/get': {
        const prompt = PROMPTS.find((p) => p.name === params.name);
        if (!prompt) throw new RpcError(-32602, `Unknown prompt: ${params.name}`);
        return rpcResult(id, {
          description: prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text: prompt.text(params.arguments ?? {}) } }],
        });
      }
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
    // An unknown CMS route falls through to the site's HTML 404 page (136KB
    // measured). Its markup tells an agent nothing and burns its context.
    if (res.status >= 400 && typeof res.body === 'string' && /^\s*</.test(res.body)) {
      res.body = { error: res.status === 404 ? 'not_found' : 'http_error', message: `No JSON answer for ${method} ${path} (the site returned an HTML page). Usually an unknown route: check it with ep_api_spec.` };
    }
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
    return toolText(`HTTP ${res.status}${rateNote(res)}\n${text ?? ''}`, res.status >= 400);
  }
  if (name === 'ep_media_upload') return mediaUpload(args, host);
  if (name === 'ep_page_inspect') return pageInspect(args, host);
  if (name === 'ep_api_spec') {
    let product = args.product;
    if (!product && !args.schema) {
      const me = await host.api('GET', '/api/v1/users/me');
      product = me.body?.product ?? 'all';
    }
    return toolText(specLookup(await cachedSpec(host), { ...args, product }));
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

// One spec covers both products. Store routes are the /api/v1/ ones plus the
// storefront's /api/shop and /api/store; every other /api/ route is the CMS's.
// (/api/v1/users/me and /api/v1/api-tokens exist on both, and the CMS lists
// its own copies under /api/, so nothing a CMS agent needs is lost.)
export function productOf(path) {
  return /^\/api\/(v1\/|shop(\/|$)|store(\/|$))/.test(path) ? 'store' : 'cms';
}

export function specLookup(spec, { search, schema, product } = {}) {
  if (schema) {
    const s = spec.components?.schemas?.[schema];
    return s ? JSON.stringify(s, null, 2) : `No schema named "${schema}".`;
  }
  const needle = search ? String(search).toLowerCase() : null;
  const scoped = product === 'cms' || product === 'store';
  const matches = Object.entries(spec.paths ?? {}).filter(([p]) => !scoped || productOf(p) === product).filter(([p, item]) => !needle
    || p.toLowerCase().includes(needle)
    || VERBS.some((v) => item[v] && [item[v].summary, ...(item[v].tags ?? [])]
      .some((t) => typeof t === 'string' && t.toLowerCase().includes(needle))));
  if (!matches.length) return `No ${scoped ? product + ' ' : ''}route matches "${search}".${scoped ? ' Pass product: "all" to search both products.' : ''}`;
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
  return `${lines.length} ${scoped ? product + ' ' : ''}operations. Narrow with search for full request/response detail.\n${lines.join('\n')}`;
}

// The tenant reports its per-token limit on every PAT response; a 429 also
// says how long to wait.
function rateNote(res) {
  const h = res.headers;
  if (res.status === 429) {
    const after = h?.get?.('Retry-After');
    return after ? ` (rate limited: retry after ${after}s)` : ' (rate limited)';
  }
  const left = h?.get?.('X-RateLimit-Remaining');
  const limit = h?.get?.('X-RateLimit-Limit');
  if (left == null || !limit) return '';
  const reset = Number(h.get('X-RateLimit-Reset')) - Math.floor(Date.now() / 1000);
  return ` (${left}/${limit} requests left${reset > 0 ? `, resets in ${reset}s` : ''})`;
}

// ── ep_page_inspect ─────────────────────────────────────────────────────────
// ponytail: regex over the HTML, not a DOM parser — the stdio host has no DOM
// and these are flat, well-formed server-rendered pages. Good enough to count
// and list; a page built from malformed markup can under-report.

async function pageInspect(args, host) {
  let path;
  let preview = false;
  if (args.page_id != null) {
    if (!Number.isInteger(args.page_id) || args.page_id < 1) return toolText('page_id must be a positive integer.', true);
    const res = await host.api('GET', `/api/v1/pages/${args.page_id}/preview-url`);
    if (res.status >= 400 || !res.body?.url) {
      return toolText(`Could not get a preview link: HTTP ${res.status}${rateNote(res)}\n${JSON.stringify(res.body)}`, true);
    }
    const u = new URL(res.body.url);
    path = u.pathname + u.search;
    preview = res.body.status !== 'published';
  } else {
    path = sitePath(args.path, host.origin);
    if (!path) return toolText('path must be a page on this site, e.g. "/page/about" (not /api/...).', true);
  }

  // Follow same-site redirects (/<slug> -> /page/<slug>), never off-site.
  let page;
  const hops = [];
  for (let i = 0; i < 4; i++) {
    page = await host.fetchPage(path);
    const to = page.status >= 300 && page.status < 400 ? sitePath(page.headers.get('Location'), host.origin) : null;
    if (!to) break;
    hops.push(`${page.status} ${path} -> ${to}`);
    path = to;
  }
  const report = inspectHtml(page.text ?? '', page.headers);
  return toolText(JSON.stringify({
    path: path.replace(/([?&]_preview=)[^&]+/, '$1…'),
    preview,
    status: page.status,
    ...(hops.length ? { redirects: hops } : {}),
    ...report,
  }, null, 2), page.status >= 400);
}

/**
 * A path on this site (resolved against its origin, so a same-site absolute
 * URL works too), never the API and never another host. Or null.
 */
export function sitePath(raw, origin) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try { u = new URL(raw, origin); } catch { return null; }
  if (u.origin !== origin || u.pathname.startsWith('/api/')) return null;
  return u.pathname + u.search;
}

const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined);
const metaContent = (html, key, val) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, key) ?? '').toLowerCase() === val) return attr(tag, 'content') ?? '';
  }
  return null;
};

export function inspectHtml(html, headers) {
  const jsonld = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const doc = JSON.parse(m[1]);
      const types = [doc].flat().flatMap((d) => [d?.['@type'], ...(d?.['@graph'] ?? []).map((g) => g?.['@type'])]).flat().filter(Boolean);
      jsonld.push(types.length ? types.join(', ') : '(no @type)');
    } catch { jsonld.push('INVALID JSON'); }
  }
  // Script and style bodies are not content: drop them before scanning.
  const body = html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const htmlTag = body.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `h${m[1]}: ${strip(m[2]).slice(0, 100)}`);
  const ids = new Set([...body.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const anchors = [...body.matchAll(/<a\b[^>]*>/gi)].map((m) => attr(m[0], 'href'));
  const brokenAnchors = [...new Set(anchors.filter((h) => h && h.startsWith('#') && h.length > 1 && !ids.has(decodeURIComponent(h.slice(1)))))];
  const placeholderLinks = anchors.filter((h) => h === '#' || h === '' || /^javascript:/i.test(h ?? '')).length;
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => ({ src: attr(m[0], 'src') ?? '', alt: attr(m[0], 'alt') }));
  const external = (src) => /^https?:\/\//i.test(src) && !src.includes('/media/') && !src.includes('/thumbnails/');
  const robotsMeta = metaContent(html, 'name', 'robots');

  return {
    robots_meta: robotsMeta,
    x_robots_tag: headers?.get?.('X-Robots-Tag') ?? null,
    indexable: !/noindex|none/i.test(`${robotsMeta ?? ''} ${headers?.get?.('X-Robots-Tag') ?? ''}`),
    cache_control: headers?.get?.('Cache-Control') ?? null,
    title: strip(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || null,
    description: metaContent(html, 'name', 'description'),
    canonical: attr(html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i)?.[0] ?? '', 'href') ?? null,
    lang: attr(htmlTag, 'lang') ?? null,
    dir: attr(htmlTag, 'dir') ?? null,
    h1_count: headings.filter((h) => h.startsWith('h1')).length,
    headings: headings.slice(0, 40),
    jsonld,
    images: {
      total: imgs.length,
      missing_alt: imgs.filter((i) => i.alt === undefined).map((i) => i.src).slice(0, 20),
      empty_alt: imgs.filter((i) => i.alt === '').length,
      hotlinked: imgs.filter((i) => external(i.src)).map((i) => i.src).slice(0, 20),
    },
    broken_anchors: brokenAnchors.slice(0, 20),
    placeholder_links: placeholderLinks,
    bytes: html.length,
  };
}

async function mediaUpload(args, host) {
  if (!args.source_url === !args.base64) return toolText('Give exactly one of source_url or base64.', true);
  if (args.product_id == null && !args.alt_text?.trim()) {
    return toolText('alt_text is required for the media library (it is how the image is described to screen readers).', true);
  }
  let file;
  try { file = await loadUpload(args); } catch (err) { return toolText(`Upload refused: ${err.message}`, true); }

  const form = new FormData();
  if (args.product_id != null) {
    if (!Number.isInteger(args.product_id) || args.product_id < 1) return toolText('product_id must be a positive integer.', true);
    form.append('files[]', file, file.name);
    const res = await host.api('POST', `/api/v1/products/${args.product_id}/images`, form);
    return toolText(`HTTP ${res.status}${rateNote(res)}\n${JSON.stringify(res.body, null, 2)}`, res.status >= 400);
  }

  // The media library is two steps: the upload lands in 'staging', and the
  // PUT with display_name + alt_text is what publishes it (media/[id].js).
  form.append('file', file, file.name);
  const up = await host.api('POST', '/api/v1/media/upload', form);
  if (up.status >= 400 || !up.body?.id) {
    return toolText(`HTTP ${up.status}${rateNote(up)}\n${JSON.stringify(up.body, null, 2)}`, true);
  }
  const meta = { display_name: args.display_name?.trim() || file.name, alt_text: args.alt_text.trim() };
  if (args.caption) meta.caption = args.caption;
  if (Array.isArray(args.tag_ids)) meta.tags = args.tag_ids;
  const put = await host.api('PUT', `/api/v1/media/${up.body.id}`, meta);
  const summary = {
    id: up.body.id,
    status: put.status < 400 ? 'published' : 'staging',
    url: up.body.location, thumbnail: up.body.thumbnail, og_url: up.body.ogUrl,
    type: file.type, size: file.size,
  };
  if (put.status >= 400) summary.metadata_error = put.body;
  return toolText(JSON.stringify(summary, null, 2), put.status >= 400);
}

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf' };

async function loadUpload(args) {
  let bytes, type, name = args.filename;
  if (args.base64) {
    const b64 = String(args.base64).replace(/^data:[^,]*,/, '');
    if (b64.length > Math.ceil(MAX_UPLOAD / 3) * 4) throw new Error('file is over 20MB');
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw new Error('base64 is not valid'); }
  } else {
    const url = publicHttpUrl(args.source_url);
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`downloading ${url.host} answered HTTP ${r.status}`);
    if (Number(r.headers.get('Content-Length')) > MAX_UPLOAD) throw new Error('file is over 20MB');
    bytes = await readCapped(r.body);
    type = r.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    name ||= decodeURIComponent(url.pathname.split('/').pop() || '');
  }
  const ext = name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  type = args.content_type?.toLowerCase() || (type && type !== 'application/octet-stream' ? type : EXT_TYPES[ext]);
  if (!type || !UPLOAD_TYPES.test(type)) throw new Error(`type ${type ?? 'unknown'} is not an image, video, audio file or PDF`);
  if (!name) name = 'upload';
  if (!ext) name += '.' + (Object.keys(EXT_TYPES).find((k) => EXT_TYPES[k] === type) ?? type.split('/')[1].replace(/\W/g, ''));
  return new File([bytes], name.slice(-120), { type });
}

async function readCapped(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > MAX_UPLOAD) throw new Error('file is over 20MB');
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// The stdio server runs on the user's machine: refuse the obvious ways an
// agent could be steered at their own network. Literal hosts only — this is
// not a DNS-rebinding defence. (In the Worker these are unreachable anyway.)
export function publicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('source_url is not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('source_url must be http or https');
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  const v6 = h.includes(':');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || (v4 && /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))
    || (v6 && (h === '::1' || h === '::' || /^(fc|fd|fe[89ab])/.test(h) || h.startsWith('::ffff:')))) {
    throw new Error('source_url must be a public address');
  }
  return u;
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
