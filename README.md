# perplexity-pro-mcp

> **Search the web from Claude or Cursor** — MCP server for Perplexity AI Pro. Deep search, follow-up questions and conversation export. Uses your existing Pro session — no extra API key needed.

MCP server for Perplexity AI Pro — deep web search, thread management, and export. Uses your browser session cookie, so it works with your existing **Perplexity Pro** subscription (no API key needed).

> ⚠️ This server uses Perplexity's unofficial internal API and a browser session cookie. It may break if Perplexity changes their API, and heavy automated use may violate Perplexity's Terms of Service. Use at your own risk.

## Tools

| Tool | Description |
|------|-------------|
| `perplexity_search` | Deep web search via Perplexity Pro (answer + sources + related queries) |
| `perplexity_follow_up` | Continue conversation in an existing thread |
| `perplexity_threads` | List recent search threads |
| `perplexity_export` | Export an answer as markdown or PDF |
| `perplexity_collections` | List saved collections |

## Setup

### 1. Get your cookie

Open https://www.perplexity.ai (logged in) → DevTools (F12) → Network tab → click any request to `perplexity.ai` → Headers → copy the full **Cookie** header value.

### 2. Configure your MCP client

**Claude Code:**

```bash
claude mcp add perplexity -e PERPLEXITY_COOKIE="<full cookie string>" -- npx -y perplexity-pro-mcp
```

**Claude Desktop / other clients** (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "perplexity": {
      "command": "npx",
      "args": ["-y", "perplexity-pro-mcp"],
      "env": {
        "PERPLEXITY_COOKIE": "<full cookie string>"
      }
    }
  }
}
```

## Parameters

### perplexity_search

- `query` — search query
- `mode` — `copilot` (deep multi-step) or `concise` (quick)
- `model` — `pplx_pro` or `pplx_alpha`
- `focus` — `internet`, `academic`, `writing`, `youtube`, `reddit`

### perplexity_follow_up

- `query` — follow-up question
- `thread_uuid` — UUID from a previous search result

### perplexity_export

- `entry_uuid` — entry UUID (from threads list)
- `format` — `md` or `pdf`

## Cookie refresh

Cookies expire in ~30 days. If you get 403 errors, copy fresh cookies from the browser.

**Note:** `perplexity_search` works with just the session token. Other tools require full cookies (including `cf_clearance`).

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm start          # run locally (requires PERPLEXITY_COOKIE)
```

## License

MIT