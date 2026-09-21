import { z } from "zod";
import { retryAfterSeconds } from "../../lib/http";
import {
  ApiTokenResponseSchema,
  AuthStatusResponseSchema,
  CreateTokenRequestSchema,
  DailySnippetContentSchema,
  DailySnippetFeedbackResponseSchema,
  DailySnippetListResponseSchema,
  DailySnippetOrganizeResponseSchema,
  DailySnippetPageDataResponseSchema,
  DailySnippetResponseSchema,
  NewApiTokenResponseSchema,
  type ApiTokenResponse,
  type AuthStatusResponse,
  type DailySnippetFeedbackResponse,
  type DailySnippetListResponse,
  type DailySnippetOrganizeResponse,
  type DailySnippetPageDataResponse,
  type DailySnippetResponse,
  type NewApiTokenResponse,
} from "./schemas";

type Fetcher = typeof fetch;

export interface ThousandSchoolClientOptions {
  baseUrl: string;
  headers?: HeadersInit;
  requestId?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export interface ListDailySnippetsParams {
  limit?: number;
  offset?: number;
  order?: string;
  fromDate?: string;
  toDate?: string;
  id?: number;
  query?: string;
}

export interface PageDataParams {
  id?: number;
  date?: string;
}

export class ThousandSchoolApiError extends Error {
  constructor(
    readonly code: "AUTH_REQUIRED" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "NETWORK_ERROR" | "INVALID_RESPONSE",
    message: string,
    readonly status?: number,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly retryAfter?: number,
  ) {
    super(message, options);
    this.name = "ThousandSchoolApiError";
  }
}

async function ssePayload(response: Response, resultField: "organized_content" | "feedback"): Promise<unknown> {
  if ((response.headers.get("content-type") ?? "").includes("application/json")) return response.json();

  const result: Record<string, unknown> = {};
  let chunks = "";
  for (const block of (await response.text()).split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch (error) {
      throw new ThousandSchoolApiError("INVALID_RESPONSE", "1000.school returned invalid SSE data", response.status, false, { cause: error });
    }
    if (event === "error") throw new ThousandSchoolApiError("UPSTREAM_ERROR", "1000.school AI processing failed", response.status);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    if (event === "chunk" && typeof record.content === "string") chunks += record.content;
    if (event === "done" || event === "message") Object.assign(result, record);
  }
  if (typeof result[resultField] !== "string" && chunks) result[resultField] = chunks;
  return result;
}

export class ThousandSchoolClient {
  private readonly baseUrl: string;
  private readonly headers: Headers;
  private readonly requestId: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: ThousandSchoolClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = new Headers(options.headers);
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async getAuthStatus(): Promise<AuthStatusResponse> {
    return this.request("/auth/me", { method: "GET" }, AuthStatusResponseSchema);
  }

  async listTokens(): Promise<ApiTokenResponse[]> {
    return this.request("/auth/tokens", { method: "GET" }, z.array(ApiTokenResponseSchema));
  }

  async createToken(description: string, idempotencyKey?: string): Promise<NewApiTokenResponse> {
    const body = CreateTokenRequestSchema.parse({ description });
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    return this.request(
      "/auth/tokens",
      { method: "POST", headers, body: JSON.stringify(body) },
      NewApiTokenResponseSchema,
    );
  }

  async deleteToken(tokenId: number): Promise<void> {
    await this.request(`/auth/tokens/${this.integer(tokenId, "tokenId")}`, { method: "DELETE" });
  }

  async listDailySnippets(params: ListDailySnippetsParams = {}): Promise<DailySnippetListResponse> {
    const query = new URLSearchParams({ scope: "own" });
    this.setNumber(query, "limit", params.limit);
    this.setNumber(query, "offset", params.offset);
    this.setString(query, "order", params.order);
    this.setString(query, "from_date", params.fromDate);
    this.setString(query, "to_date", params.toDate);
    this.setNumber(query, "id", params.id);
    this.setString(query, "q", params.query);
    return this.request(`/daily-snippets?${query}`, { method: "GET" }, DailySnippetListResponseSchema);
  }

  async getDailySnippet(snippetId: number): Promise<DailySnippetResponse> {
    return this.request(
      `/daily-snippets/${this.integer(snippetId, "snippetId")}`,
      { method: "GET" },
      DailySnippetResponseSchema,
    );
  }

  async createDailySnippet(content: string): Promise<DailySnippetResponse> {
    return this.request(
      "/daily-snippets",
      { method: "POST", body: JSON.stringify(DailySnippetContentSchema.parse({ content })) },
      DailySnippetResponseSchema,
    );
  }

  async updateDailySnippet(snippetId: number, content: string): Promise<DailySnippetResponse> {
    return this.request(
      `/daily-snippets/${this.integer(snippetId, "snippetId")}`,
      { method: "PUT", body: JSON.stringify(DailySnippetContentSchema.parse({ content })) },
      DailySnippetResponseSchema,
    );
  }

  async deleteDailySnippet(snippetId: number): Promise<void> {
    await this.request(`/daily-snippets/${this.integer(snippetId, "snippetId")}`, { method: "DELETE" });
  }

  async organizeDailySnippet(content: string, stream?: boolean): Promise<DailySnippetOrganizeResponse> {
    const query = stream === true ? "?stream=1" : stream === false ? "?stream=false" : "";
    return this.request(
      `/daily-snippets/organize${query}`,
      { method: "POST", headers: stream ? { accept: "text/event-stream" } : undefined, body: JSON.stringify(DailySnippetContentSchema.parse({ content })) },
      DailySnippetOrganizeResponseSchema,
      stream ? (response) => ssePayload(response, "organized_content") : undefined,
      false,
    );
  }

  async getDailySnippetFeedback(stream?: boolean): Promise<DailySnippetFeedbackResponse> {
    const query = stream === true ? "?stream=1" : stream === false ? "?stream=false" : "";
    return this.request(
      `/daily-snippets/feedback${query}`,
      { method: "GET", headers: stream ? { accept: "text/event-stream" } : undefined },
      DailySnippetFeedbackResponseSchema,
      stream ? (response) => ssePayload(response, "feedback") : undefined,
      false,
    );
  }

  async getDailySnippetPageData(params: PageDataParams = {}): Promise<DailySnippetPageDataResponse> {
    const query = new URLSearchParams();
    this.setNumber(query, "id", params.id);
    this.setString(query, "date", params.date);
    const suffix = query.toString() ? `?${query}` : "";
    return this.request(
      `/daily-snippets/page-data${suffix}`,
      { method: "GET" },
      DailySnippetPageDataResponseSchema,
    );
  }

  private async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>, decode?: (response: Response) => Promise<unknown>, retryAmbiguous?: boolean): Promise<T>;
  private async request(path: string, init: RequestInit): Promise<void>;
  private async request<T>(path: string, init: RequestInit, schema?: z.ZodType<T>, decode?: (response: Response) => Promise<unknown>, retryAmbiguous = true): Promise<T | void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(this.headers);
    headers.set("accept", "application/json");
    headers.set("x-request-id", this.requestId);
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? "AUTH_REQUIRED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_ERROR";
        throw new ThousandSchoolApiError(
          code,
          `1000.school request failed (${response.status})`,
          response.status,
          code === "RATE_LIMITED" || (retryAmbiguous && response.status >= 500),
          undefined,
          retryAfterSeconds(response.headers.get("retry-after")),
        );
      }

      if (!schema) return;
      let payload: unknown;
      try {
        payload = await (decode ? decode(response) : response.json());
      } catch (error) {
        if (error instanceof ThousandSchoolApiError) throw error;
        throw new ThousandSchoolApiError("INVALID_RESPONSE", "1000.school returned invalid JSON", response.status, false, {
          cause: error,
        });
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ThousandSchoolApiError("INVALID_RESPONSE", "1000.school response did not match the API contract", response.status, false, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ThousandSchoolApiError) throw error;
      throw new ThousandSchoolApiError("NETWORK_ERROR", "1000.school request failed", undefined, retryAmbiguous, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private integer(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    return value;
  }

  private setNumber(query: URLSearchParams, name: string, value: number | undefined): void {
    if (value !== undefined) query.set(name, String(value));
  }

  private setString(query: URLSearchParams, name: string, value: string | undefined): void {
    if (value !== undefined) query.set(name, value);
  }
}
