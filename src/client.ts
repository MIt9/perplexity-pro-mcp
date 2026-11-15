import { randomUUID } from "crypto";

const BASE_URL = "https://www.perplexity.ai";

export interface WebResult {
  name: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  answer: string;
  sources: WebResult[];
  related_queries: string[];
  thread_uuid: string;
  entry_uuid: string;
}

export interface Thread {
  uuid: string;
  title: string;
  status: string;
  mode_type: string;
  answer_preview?: string;
}

export interface ExportResult {
  content: string;
  filename: string;
}

export class PerplexityClient {
  private cookie: string;

  constructor(cookie: string) {
    this.cookie = cookie;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: "*/*",
      cookie: this.cookie,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "x-app-apiclient": "default",
      "x-app-apiversion": "2.18",
      referer: "https://www.perplexity.ai/",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      ...extra,
    };
  }

  async search(
    query: string,
    opts?: { mode?: string; model?: string; focus?: string }
  ): Promise<SearchResult> {
    const frontendUuid = randomUUID();
    const contextUuid = randomUUID();

    const body = {
      query_str: query,
      params: {
        attachments: [],
        language: "en-US",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        search_focus: opts?.focus ?? "internet",
        sources: ["web"],
        frontend_uuid: frontendUuid,
        mode: opts?.mode ?? "copilot",
        model_preference: opts?.model ?? "pplx_pro",
        is_related_query: false,
        is_sponsored: false,
        frontend_context_uuid: contextUuid,
        prompt_source: "user",
        query_source: "home",
        is_incognito: false,
        use_schematized_api: true,
        send_back_text_in_streaming_api: false,
        supported_block_use_cases: [
          "answer_modes",
          "media_items",
          "knowledge_cards",
          "search_result_widgets",
          "inline_images",
        ],
        version: "2.18",
      },
    };

    const res = await fetch(`${BASE_URL}/rest/sse/perplexity_ask`, {
      method: "POST",
      headers: this.headers({ accept: "text/event-stream", "content-type": "application/json" }),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Perplexity API error: ${res.status} ${res.statusText}`);
    }

    return this.parseSSE(await res.text());
  }

  private parseSSE(raw: string): SearchResult {
    const parts = raw.split("event: message");
    let finalData: any = null;

    for (const part of [...parts].reverse()) {
      if (!part.includes('"final_sse_message": true') && !part.includes('"final_sse_message":true')) continue;
      const idx = part.indexOf("data: ");
      if (idx < 0) continue;
      let jsonStr = part.slice(idx + 6).trim();
      const endIdx = jsonStr.indexOf("\nevent:");
      if (endIdx > 0) jsonStr = jsonStr.slice(0, endIdx);
      try {
        finalData = JSON.parse(jsonStr);
        break;
      } catch {}
    }

    if (!finalData) throw new Error("No final SSE message found in response");

    let answer = "";
    const sources: WebResult[] = [];

    if (Array.isArray(finalData.blocks)) {
      // Current API: answer and sources come as typed blocks.
      for (const block of finalData.blocks) {
        if (block.markdown_block?.answer) {
          answer = block.markdown_block.answer;
        }
        for (const wr of block.web_result_block?.web_results ?? []) {
          sources.push({ name: wr.name, url: wr.url, snippet: wr.snippet });
        }
      }
    } else if (typeof finalData.text === "string") {
      // Legacy API: text is a JSON-encoded array of steps.
      try {
        const steps = JSON.parse(finalData.text);
        for (const step of steps) {
          if (step.step_type === "FINAL") {
            answer = step.content?.answer ?? "";
          }
          if (step.step_type === "SEARCH_RESULTS") {
            for (const wr of step.content?.web_results ?? []) {
              sources.push({ name: wr.name, url: wr.url, snippet: wr.snippet });
            }
          }
        }
      } catch {
        answer = finalData.text;
      }
    }

    const related = (finalData.related_query_items ?? []).map(
      (r: any) => r.text ?? r
    );

    return {
      answer,
      sources,
      related_queries: related,
      thread_uuid: finalData.thread_url_slug ?? finalData.backend_uuid ?? "",
      entry_uuid: finalData.uuid ?? "",
    };
  }

  private getAccountId(): string | undefined {
    const m = this.cookie.match(/__Host-pplx-last-active-account=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : undefined;
  }

  async listThreads(limit = 20, searchTerm?: string): Promise<Thread[]> {
    const term = searchTerm && searchTerm.trim() ? searchTerm.trim() : null;
    const variables: Record<string, any> = {
      includePins: term === null,
      includeFirstMessagePreview: true,
      includeSearchPreview: term !== null,
      searchTerm: term,
      sortOrder: "NEWEST",
      statuses: null,
      threadTypes: null,
      sources: null,
      excludedSources: ["MCP"],
      includeTemporary: null,
      viewerState: null,
      itemTypes: ["THREAD", "AUTOMATION"],
    };

    const headers: Record<string, string> = {
      ...this.headers({ "content-type": "application/json" }),
    };
    const accountId = this.getAccountId();
    if (accountId) headers["x-pplx-account"] = accountId;

    const res = await fetch(`${BASE_URL}/rest/perplexity_ask/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "LibraryItemsRelayQuery",
        variables,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "e2bf595eeae8f8959404884314c6b5fb2209014c4992d6a228cdfbc64cac24a0",
          },
        },
      }),
    });

    // Fallback to the legacy REST endpoint when GraphQL is unavailable (and no search term).
    if (!res.ok) {
      if (term) throw new Error(`Failed to search threads: ${res.status} ${res.statusText}`);
      const r2 = await fetch(
        `${BASE_URL}/rest/thread/list_recent?limit=${limit}&exclude_asi=false&version=2.18&source=default`,
        { headers: this.headers() }
      );
      if (!r2.ok) throw new Error(`Failed to list threads: ${r2.status} ${r2.statusText}`);
      const data = await r2.json();
      if (!Array.isArray(data)) return [];
      return (data as any[]).slice(0, limit);
    }

    const data: any = await res.json();
    if (data?.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    const edges: any[] = [];
    const groups = [
      data?.data?.viewer?.pinnedGroup?.items?.edges,
      data?.data?.viewer?.recentGroup?.items?.edges,
    ];
    for (const g of groups) {
      if (Array.isArray(g)) edges.push(...g);
    }

    const seen = new Set<string>();
    const threads: Thread[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      const obj = node?.object ?? {};
      const uuid = obj.slug ?? obj.entryId ?? obj.contextUUID ?? node?.id;
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      threads.push({
        uuid,
        title: node?.title ?? obj.name ?? obj.firstMessagePreview ?? "Untitled",
        status: String(obj.status ?? node?.status ?? "").toLowerCase(),
        mode_type: String(obj.mode ?? ""),
        answer_preview: obj.answerPreview ?? node?.searchPreview ?? undefined,
      });
    }

    return threads.slice(0, limit);
  }

  async exportEntry(entryUuid: string, format: "md" | "pdf" = "md"): Promise<ExportResult> {
    const res = await fetch(`${BASE_URL}/rest/entry/export`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ entry_uuid: entryUuid, format }),
    });
    if (!res.ok) throw new Error(`Failed to export: ${res.status}`);
    const data = await res.json();
    const content = Buffer.from(data.file_content_64, "base64").toString("utf-8");
    return { content, filename: data.filename };
  }

  async checkSession(): Promise<boolean> {
    const res = await fetch(`${BASE_URL}/api/auth/session?version=2.18&source=default`, {
      headers: this.headers(),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data?.user;
  }

  async followUp(
    query: string,
    threadUuid: string,
    opts?: { mode?: string; model?: string; focus?: string }
  ): Promise<SearchResult> {
    const frontendUuid = randomUUID();

    const body = {
      query_str: query,
      params: {
        attachments: [],
        language: "en-US",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        search_focus: opts?.focus ?? "internet",
        sources: ["web"],
        frontend_uuid: frontendUuid,
        mode: opts?.mode ?? "copilot",
        model_preference: opts?.model ?? "pplx_pro",
        is_related_query: true,
        is_sponsored: false,
        frontend_context_uuid: threadUuid,
        prompt_source: "user",
        query_source: "followup",
        is_incognito: false,
        use_schematized_api: true,
        send_back_text_in_streaming_api: false,
        supported_block_use_cases: [
          "answer_modes",
          "media_items",
          "knowledge_cards",
          "search_result_widgets",
          "inline_images",
        ],
        version: "2.18",
      },
    };

    const res = await fetch(`${BASE_URL}/rest/sse/perplexity_ask`, {
      method: "POST",
      headers: this.headers({ accept: "text/event-stream", "content-type": "application/json" }),
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Follow-up error: ${res.status} ${res.statusText}`);
    return this.parseSSE(await res.text());
  }

  async listCollections(): Promise<any[]> {
    const res = await fetch(
      `${BASE_URL}/rest/collections/list_user_collections?version=2.18&source=default`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Failed to list collections: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }
}
