# EdgePress MCP server

Connect any MCP-capable AI agent (Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI…) to **your** EdgePress site — CMS or store — with a personal access token.

Two tools:

- `ep_request` — call your site's REST API (`/api/v1`), e.g. `GET /posts?limit=3`, `POST /pages`.
- `ep_api_spec` — look up routes and request bodies in the [OpenAPI spec](https://api-docs.edgepress.cc).

The token decides what the agent can do: its role, and whether it is `read_only`. Nothing else is granted.

## 1. Create a token

Admin → **API tokens** → New token. It starts with `epat_`. Pick read-only unless the agent should write.

## 2a. Hosted (nothing to install)

Every site serves MCP at `https://<your-site>/api/mcp` (Streamable HTTP).

Claude Code:

```bash
claude mcp add --transport http edgepress https://blog.edgepress.cc/api/mcp \
  --header "Authorization: Bearer epat_..."
```

Cursor / VS Code / other clients (`mcp.json`):

```json
{
  "mcpServers": {
    "edgepress": {
      "url": "https://blog.edgepress.cc/api/mcp",
      "headers": { "Authorization": "Bearer epat_..." }
    }
  }
}
```

### ChatGPT, claude.ai and other OAuth connectors

No token to paste: add a custom connector with the URL `https://<your-site>/api/mcp` and OAuth authentication. You sign in to your site, choose **read & write** or **read-only**, and the connector receives an API token named after it — revoke it any time under Admin → API tokens. (On a store, only admins can approve.)

## 2b. Local (stdio, Node 22+)

For clients that only run local servers (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "edgepress": {
      "command": "npx",
      "args": ["-y", "github:edgepress-cc/mcp-edgepress"],
      "env": { "EDGEPRESS_TENANT": "blog.edgepress.cc", "EDGEPRESS_TOKEN": "epat_..." }
    }
  }
}
```

## Limits

- Media upload (multipart) is not available through MCP — use the admin UI.
- Large responses are truncated at 50k characters; page list endpoints instead.

`src/mcp.js` is a copy of `dispatcher/src/mcp.js` in the EdgePress platform repo — do not edit it here.
