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

    // Parse text field (JSON array of steps)
    let answer = "";
    const sources: WebResult[] = [];

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
      // Fallback: text might be plain string
      answer = finalData.text ?? "";
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

  async listThreads(limit = 20): Promise<Thread[]> {
    const res = await fetch(
      `${BASE_URL}/rest/thread/list_recent?limit=${limit}&exclude_asi=false&version=2.18&source=default`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Failed to list threads: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data;
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
