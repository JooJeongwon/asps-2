import { z } from "zod";
import {
  NotionBlockListSchema,
  NotionPageListSchema,
  NotionPageSchema,
  type NotionBlock,
  type NotionPage,
  type NotionQueryBody,
} from "./schemas";

type Fetcher = typeof fetch;
const NOTION_VERSION = "2026-03-11";

export interface NotionClientOptions {
  token: string;
  baseUrl?: string;
  version?: string;
  requestId?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export class NotionApiError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "NETWORK_ERROR" | "INVALID_RESPONSE",
    message: string,
    readonly status?: number,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NotionApiError";
  }
}

export class NotionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly version: string;
  private readonly requestId: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: NotionClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.notion.com/v1").replace(/\/$/, "");
    this.token = options.token;
    this.version = options.version ?? NOTION_VERSION;
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async queryDataSource(dataSourceId: string, body: NotionQueryBody = {}): Promise<{ pages: NotionPage[]; nextCursor: string | null; hasMore: boolean }> {
    const response = await this.request(
      `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      { method: "POST", body: JSON.stringify(body) },
      NotionPageListSchema,
    );
    return { pages: response.results, nextCursor: response.next_cursor ?? null, hasMore: response.has_more };
  }

  async listAllPages(dataSourceId: string, body: NotionQueryBody = {}): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.queryDataSource(dataSourceId, {
        ...body,
        page_size: body.page_size ?? 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      pages.push(...page.pages);
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    return pages;
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    return this.request(`/pages/${encodeURIComponent(pageId)}`, { method: "GET" }, NotionPageSchema);
  }

  async listBlockChildren(blockId: string, startCursor?: string): Promise<{ blocks: NotionBlock[]; nextCursor: string | null; hasMore: boolean }> {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) query.set("start_cursor", startCursor);
    const response = await this.request(
      `/blocks/${encodeURIComponent(blockId)}/children?${query}`,
      { method: "GET" },
      NotionBlockListSchema,
    );
    return { blocks: response.results, nextCursor: response.next_cursor ?? null, hasMore: response.has_more };
  }

  async listAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listBlockChildren(blockId, cursor ?? undefined);
      blocks.push(...page.blocks);
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    return blocks;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return this.request(
      `/pages/${encodeURIComponent(pageId)}`,
      { method: "PATCH", body: JSON.stringify({ properties }) },
      NotionPageSchema,
    );
  }

  private async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "notion-version": this.version,
      "x-request-id": this.requestId,
    });
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? "AUTH_REQUIRED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_ERROR";
        throw new NotionApiError(code, `Notion request failed (${response.status})`, response.status, code === "RATE_LIMITED" || response.status >= 500 || response.status === 529);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new NotionApiError("INVALID_RESPONSE", "Notion returned invalid JSON", response.status, false, { cause: error });
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new NotionApiError("INVALID_RESPONSE", "Notion response did not match the API contract", response.status, false, { cause: parsed.error });
      return parsed.data;
    } catch (error) {
      if (error instanceof NotionApiError) throw error;
      throw new NotionApiError("NETWORK_ERROR", "Notion request failed", undefined, true, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
