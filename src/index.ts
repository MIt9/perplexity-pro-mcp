#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PerplexityClient } from "./client.js";

const cookie = process.env.PERPLEXITY_COOKIE;
if (!cookie) {
  console.error("PERPLEXITY_COOKIE env var is required");
  process.exit(1);
}

const client = new PerplexityClient(cookie);
const server = new McpServer({
  name: "perplexity-pro-mcp",
  version: "1.0.0",
});

server.tool(
  "perplexity_search",
  "Search the web using Perplexity AI Pro. Returns a detailed answer with citations and sources. Optionally upload local files (any file type) to be analyzed alongside the search query.",
  {
    query: z.string().describe("Search query"),
    mode: z.enum(["copilot", "concise"]).default("copilot").describe("copilot = deep multi-step search, concise = quick answer"),
    model: z.enum(["pplx_pro", "pplx_alpha"]).default("pplx_pro").describe("Model to use"),
    focus: z.enum(["internet", "academic", "writing", "youtube", "reddit"]).default("internet").describe("Search focus"),
    file_paths: z.array(z.string()).optional().describe("Optional local file paths to upload (absolute or relative). ALL file types are accepted; unrecognized extensions are sent as application/octet-stream."),
  },
  async ({ query, mode, model, focus, file_paths }) => {
    const result =
      file_paths && file_paths.length > 0
        ? await client.searchWithFiles(query, file_paths, { mode, model, focus })
        : await client.search(query, { mode, model, focus });

    let text = result.answer + "\n\n";
    if (result.sources.length > 0) {
      text += "## Sources\n";
      for (const s of result.sources) {
        text += `- [${s.name}](${s.url})\n`;
      }
    }
    if (result.related_queries.length > 0) {
      text += "\n## Related queries\n";
      for (const q of result.related_queries) {
        text += `- ${q}\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "perplexity_threads",
  "List recent Perplexity search threads. Optionally filter by a search term (matches titles and conversation content).",
  {
    limit: z.number().default(10).describe("Number of threads to return"),
    search: z.string().optional().describe("Optional search term to filter threads by title/content"),
  },
  async ({ limit, search }) => {
    const threads = await client.listThreads(limit, search);
    const text = threads
      .map((t) => `- [${t.status}] ${t.title} (uuid: ${t.uuid})`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No threads found" }] };
  }
);

server.tool(
  "perplexity_export",
  "Export a Perplexity answer entry as markdown or PDF.",
  {
    entry_uuid: z.string().describe("Entry UUID (from perplexity_search result or thread)"),
    format: z.enum(["md", "pdf"]).default("md").describe("Export format"),
  },
  async ({ entry_uuid, format }) => {
    const result = await client.exportEntry(entry_uuid, format);
    return { content: [{ type: "text", text: result.content }] };
  }
);

server.tool(
  "perplexity_follow_up",
  "Continue a conversation in an existing Perplexity thread. Use thread_uuid from a previous search result.",
  {
    query: z.string().describe("Follow-up question"),
    thread_uuid: z.string().describe("Thread UUID from a previous perplexity_search result"),
    mode: z.enum(["copilot", "concise"]).default("copilot").describe("deep search, concise = quick"),
    model: z.enum(["pplx_pro", "pplx_alpha"]).default("pplx_pro").describe("Model to use"),
    focus: z.enum(["internet", "academic", "writing", "youtube", "reddit"]).default("internet").describe("Search focus"),
  },
  async ({ query, thread_uuid, mode, model, focus }) => {
    const result = await client.followUp(query, thread_uuid, { mode, model, focus });

    let text = result.answer + "\n\n";
    if (result.sources.length > 0) {
      text += "## Sources\n";
      for (const s of result.sources) {
        text += `- [${s.name}](${s.url})\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "perplexity_collections",
  "List user's Perplexity collections (saved threads).",
  {},
  async () => {
    const collections = await client.listCollections();
    if (collections.length === 0) return { content: [{ type: "text", text: "No collections found" }] };
    const text = collections
      .map((c: any) => `- ${c.title ?? c.name ?? "Untitled"} (uuid: ${c.uuid ?? c.id})`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "perplexity_quota",
  "Check Perplexity rate-limit status per mode (pro_search, research/deep-research, labs, agentic_research). Call this before perplexity_deep_research to see if Deep Research is actually available.",
  {},
  async () => {
    const modes = await client.checkQuota();
    const lines = Object.entries(modes).map(([name, m]) => {
      const rem = m?.remaining_detail?.remaining;
      return `${m?.available ? "✅" : "❌"} ${name}: ${m?.available ? "available" : `0 remaining${typeof rem === "number" && rem !== 0 ? ` (${rem})` : ""}`}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") || "No rate-limit data returned" }] };
  }
);

server.tool(
  "perplexity_deep_research",
  "Run a Perplexity Deep Research query (mode=research + pplx_alpha, exactly as the web UI sends). A real Deep Research run takes several minutes and consumes quota; if quota is exhausted the backend silently downgrades to a fast regular search. Check perplexity_quota first. The result includes a downgrade warning when pro_search_mode comes back as 'auto'.",
  {
    query: z.string().describe("Deep research question — should be broad and analytical"),
    focus: z.enum(["internet", "academic", "writing", "youtube", "reddit"]).default("internet").describe("Search focus"),
  },
  async ({ query, focus }) => {
    let quotaWarning = "";
    try {
      const modes = await client.checkQuota();
      const r = modes?.research;
      if (r && r.available === false) {
        quotaWarning =
          "> ⚠️ **Downgrade expected:** Deep Research quota is exhausted on this account — the backend will silently downgrade this request to a fast regular search.\n\n";
      }
    } catch {}

    const result = await client.deepResearch(query, { focus });

    let text = quotaWarning;
    if (!quotaWarning && result.pro_search_mode === "auto") {
      text +=
        "> ⚠️ Note: backend echoed pro_search_mode 'auto' — request was likely downgraded from Deep Research.\n\n";
    }
    text += result.answer + "\n\n";
    if (result.sources.length > 0) {
      text += "## Sources\n";
      for (const s of result.sources) {
        text += `- [${s.name}](${s.url})\n`;
      }
    }
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
