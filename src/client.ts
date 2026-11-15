import { randomUUID } from "crypto";
import { Agent, fetch as undiciFetch } from "undici";

// Disable idle timeouts so long-running Deep Research streams (which can run
// many minutes) are not killed by undici's default 5-minute bodyTimeout.
const NO_TIMEOUT_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const BASE_URL = "https://www.perplexity.ai";

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".rtf": "text/rtf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".xml": "text/plain",
  ".css": "text/css",
  ".scss": "text/plain",
  ".sass": "text/plain",
  ".js": "text/plain",
  ".mjs": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".py": "text/plain",
  ".rb": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".java": "text/plain",
  ".c": "text/plain",
  ".cpp": "text/plain",
  ".h": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".sql": "text/plain",
  ".log": "text/plain",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".conf": "text/plain",
  ".tex": "text/plain",
  ".bib": "text/plain",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
};

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
  pro_search_mode: string | null;
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

export interface QuotaMode {
  available?: boolean;
  remaining_detail?: { remaining?: number };
  [key: string]: unknown;
}

export type QuotaModes = Record<string, QuotaMode>;

export class PerplexityClient {
  private cookie: string;

  constructor(cookie: string) {
    this.cookie = cookie;
  }

  /**
   * Derive the account UUID from the session cookie.
   *
   * Perplexity names its session cookie `__Secure-pplx.session.<uuid>`; that
   * UUID is the account id. Without the `x-pplx-account` header the backend
   * treats requests as anonymous (pro/research quota reads as 0). Falls back to
   * the `__Host-pplx-last-active-account` cookie when the session cookie is not
   * named after the account.
   */
  private getAccountId(): string | undefined {
    const session = this.cookie.match(/__Secure-pplx\.session\.([0-9a-f-]{36})/i);
    if (session) return session[1];

    const active = this.cookie.match(/__Host-pplx-last-active-account=([^;]+)/);
    return active ? decodeURIComponent(active[1]) : undefined;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const accountId = this.getAccountId();
    return {
      accept: "*/*",
      cookie: this.cookie,
      "user-agent":
        process.env.PERPLEXITY_USER_AGENT ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "x-app-apiclient": "default",
      "x-app-apiversion": "2.18",
      ...(accountId ? { "x-pplx-account": accountId } : {}),
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
    return this._search(query, opts, []);
  }

  /**
   * Search with local files attached. Any file type is accepted; unknown
   * extensions are sent as `application/octet-stream`.
   */
  async searchWithFiles(
    query: string,
    filePaths: string[],
    opts?: { mode?: string; model?: string; focus?: string }
  ): Promise<SearchResult> {
    const fs = await import("fs");
    const path = await import("path");

    const attachments: Array<{
      type: string;
      name: string;
      mime_type: string;
      data: string;
    }> = [];

    for (const fp of filePaths) {
      const abs = path.resolve(fp);
      const data = fs.readFileSync(abs).toString("base64");
      const ext = path.extname(abs).toLowerCase();
      attachments.push({
        type: "file",
        name: path.basename(abs),
        mime_type: MIME_MAP[ext] || "application/octet-stream",
        data,
      });
    }

    return this._search(query, opts, attachments);
  }

  private async _search(
    query: string,
    opts: { mode?: string; model?: string; focus?: string } | undefined,
    attachments: Array<{
      type: string;
      name: string;
      mime_type: string;
      data: string;
    }>
  ): Promise<SearchResult> {
    const frontendUuid = randomUUID();
    const contextUuid = randomUUID();

    const body = {
      query_str: query,
      params: {
        attachments,
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
      if (!part.includes('"final_sse_message": true') && !part.includes('"final_sse_message":true'))
        continue;
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

    if (finalData.status === "failed" || finalData.error_code) {
      throw new Error(
        `Perplexity query failed: ${finalData.error_code ?? "UNKNOWN"} ${finalData.error_message ?? finalData.detail ?? ""}`.trim()
      );
    }

    const blocks: any[] = Array.isArray(finalData.blocks) ? finalData.blocks : [];
    const sources: WebResult[] = [];
    const seenUrls = new Set<string>();
    const pushSource = (wr: any) => {
      const url = wr?.url;
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      sources.push({ name: wr?.name ?? wr?.title ?? "", url, snippet: wr?.snippet ?? "" });
    };

    let answer = "";
    let stepsAnswer: string | undefined;
    let stepsParsed = false;

    // Legacy API: text is a JSON-encoded array of steps.
    if (typeof finalData.text === "string") {
      try {
        const steps = JSON.parse(finalData.text);
        stepsParsed = true;
        for (const step of steps) {
          if (step.step_type === "FINAL") {
            stepsAnswer = step.content?.answer ?? "";
          }
          if (step.step_type === "SEARCH_RESULTS") {
            for (const wr of step.content?.web_results ?? []) pushSource(wr);
          }
        }
      } catch {
        // Not JSON — the text field is a plain string answer.
      }
    }

    // Current API: answer comes as a typed markdown block.
    for (const block of blocks) {
      if (block?.markdown_block?.answer) {
        answer = block.markdown_block.answer;
        break;
      }
    }
    if (!answer && stepsAnswer !== undefined) answer = stepsAnswer;

    // Fallback: text might be a plain (non-JSON) string.
    if (!answer && !stepsParsed && typeof finalData.text === "string") answer = finalData.text;

    // Research-mode: the answer lives in blocks[].markdown_block.chunks[].
    if (!answer && blocks.length > 0) {
      const chunks: string[] = [];
      for (const block of blocks) {
        const mb = block?.markdown_block;
        if (Array.isArray(mb?.chunks)) {
          for (const c of mb.chunks) chunks.push(typeof c === "string" ? c : (c?.text ?? ""));
        }
      }
      answer = chunks.join("");
    }

    // Blocks-based source extraction (research-mode responses).
    if (sources.length === 0) {
      for (const block of blocks) {
        for (const wr of block?.web_result_block?.web_results ?? []) pushSource(wr);
      }
    }

    const related = (finalData.related_query_items ?? []).map((r: any) => r.text ?? r);

    return {
      answer,
      sources,
      related_queries: related,
      thread_uuid: finalData.thread_url_slug ?? finalData.backend_uuid ?? "",
      entry_uuid: finalData.uuid ?? "",
      pro_search_mode: finalData._extras?.pro_search_mode ?? null,
    };
  }

  /** Per-mode rate limit status (pro_search, research, labs, agentic_research). */
  async checkQuota(): Promise<QuotaModes> {
    const res = await fetch(`${BASE_URL}/rest/rate-limit/status`, {
      headers: this.headers({ accept: "application/json" }),
    });
    if (!res.ok) throw new Error(`Failed to check rate limits: ${res.status} ${res.statusText}`);
    const data: any = await res.json();
    return (data?.modes ?? data) as QuotaModes;
  }

  /** Deep Research (mode=research + pplx_alpha), exactly as the web UI sends it. */
  async deepResearch(
    query: string,
    opts?: { focus?: string }
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
        mode: "research",
        model_preference: "pplx_alpha",
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

    const res = await undiciFetch(`${BASE_URL}/rest/sse/perplexity_ask`, {
      method: "POST",
      headers: this.headers({ accept: "text/event-stream", "content-type": "application/json" }),
      body: JSON.stringify(body),
      dispatcher: NO_TIMEOUT_AGENT,
    });

    if (!res.ok) {
      throw new Error(`Perplexity API error: ${res.status} ${res.statusText}`);
    }

    return this.parseSSE(await res.text());
  }

  /**
   * List recent threads, optionally filtered by a search term.
   *
   * Uses Perplexity's internal GraphQL `LibraryItemsRelayQuery`, whose
   * `searchTerm` variable filters server-side across thread titles *and*
   * conversation content. Pinned and recent groups are merged and deduped; the
   * legacy REST endpoint is used as a fallback when GraphQL is unavailable.
   */
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

    const res = await fetch(`${BASE_URL}/rest/perplexity_ask/graphql`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
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
