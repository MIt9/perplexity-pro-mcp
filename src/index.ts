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
  "Search the web using Perplexity AI Pro. Returns a detailed answer with citations and sources.",
  {
    query: z.string().describe("Search query"),
    mode: z.enum(["copilot", "concise"]).default("copilot").describe("copilot = deep multi-step search, concise = quick answer"),
    model: z.enum(["pplx_pro", "pplx_alpha"]).default("pplx_pro").describe("Model to use"),
    focus: z.enum(["internet", "academic", "writing", "youtube", "reddit"]).default("internet").describe("Search focus"),
  },
  async ({ query, mode, model, focus }) => {
    const result = await client.search(query, { mode, model, focus });

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
  "List recent Perplexity search threads.",
  {
    limit: z.number().default(10).describe("Number of threads to return"),
  },
  async ({ limit }) => {
    const threads = await client.listThreads(limit);
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
    mode: z.enum(["copilot", "concise"]).default("copilot").describe("copilot = deep search, concise = quick"),
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

const transport = new StdioServerTransport();
await server.connect(transport);
