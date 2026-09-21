import assert from "node:assert/strict";
import test from "node:test";
import { ThousandSchoolApiError, ThousandSchoolClient } from "../src/services/thousand-school/client.ts";
import { apiTokenFixture, authStatusFixture, dailySnippetListFixture } from "./fixtures/thousand-school.ts";

function fetcher(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("daily snippet list is limited to the current user's scope", async () => {
  let request: Request | undefined;
  const client = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid/",
    fetcher: fetcher((incoming) => { request = incoming; return json(dailySnippetListFixture); }),
  });

  const result = await client.listDailySnippets({ fromDate: "2026-09-01", toDate: "2026-09-19" });
  const query = new URL(request!.url).searchParams;
  assert.equal(query.get("scope"), "own");
  assert.equal(query.get("from_date"), "2026-09-01");
  assert.equal(result.items[0]?.content, "sanitized fixture content");
});

test("documented token and auth contracts are sent and validated", async () => {
  let request: Request | undefined;
  const client = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    headers: { authorization: "Bearer sanitized-header" },
    fetcher: fetcher((incoming) => { request = incoming; return json(apiTokenFixture); }),
  });

  const result = await client.createToken("sanitized test token", "idempotency-1");
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("authorization"), "Bearer sanitized-header");
  assert.equal(request?.headers.get("idempotency-key"), "idempotency-1");
  assert.deepEqual(await request?.json(), { description: "sanitized test token" });
  assert.equal(result.id, 11);

  const authClient = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    fetcher: fetcher(() => json(authStatusFixture)),
  });
  assert.equal((await authClient.getAuthStatus()).authenticated, true);
});

test("upstream auth and malformed responses are safe typed errors", async () => {
  const authClient = new ThousandSchoolClient({ baseUrl: "https://api.example.invalid", fetcher: fetcher(() => json({}, 401)) });
  await assert.rejects(() => authClient.getAuthStatus(), (error: unknown) => {
    return error instanceof ThousandSchoolApiError && error.code === "AUTH_REQUIRED" && !error.retryable;
  });

  const malformedClient = new ThousandSchoolClient({ baseUrl: "https://api.example.invalid", fetcher: fetcher(() => json({})) });
  await assert.rejects(() => malformedClient.getAuthStatus(), (error: unknown) => {
    return error instanceof ThousandSchoolApiError && error.code === "INVALID_RESPONSE";
  });
});

test("retry-after is preserved for retryable upstream failures", async () => {
  const client = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    fetcher: fetcher(() => new Response(null, { status: 429, headers: { "retry-after": "17" } })),
  });
  await assert.rejects(() => client.getAuthStatus(), (error: unknown) => {
    return error instanceof ThousandSchoolApiError && error.retryable && error.retryAfter === 17;
  });
});

test("AI endpoints use the website streaming contract", async () => {
  const requests: Request[] = [];
  const client = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    fetcher: fetcher((request) => {
      requests.push(request);
      const feedback = request.url.includes("/feedback");
      const field = feedback ? "feedback" : "organized_content";
      const body = `event: chunk\ndata: {"content":"rich "}\n\nevent: done\ndata: {"date":"2026-09-19","${field}":"rich result"}\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }),
  });

  assert.equal((await client.organizeDailySnippet("raw", true)).organized_content, "rich result");
  assert.equal((await client.getDailySnippetFeedback(true)).feedback, "rich result");
  assert.ok(requests.every((request) => new URL(request.url).searchParams.get("stream") === "1"));
  assert.ok(requests.every((request) => request.headers.get("accept") === "text/event-stream"));
});

test("ambiguous AI failures are not automatically retried", async () => {
  const networkClient = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    fetcher: fetcher(() => { throw new TypeError("network failed"); }),
  });
  await assert.rejects(networkClient.organizeDailySnippet("raw", true), (error: unknown) => {
    return error instanceof ThousandSchoolApiError && error.code === "NETWORK_ERROR" && !error.retryable;
  });

  const upstreamClient = new ThousandSchoolClient({
    baseUrl: "https://api.example.invalid",
    fetcher: fetcher(() => new Response(null, { status: 503 })),
  });
  await assert.rejects(upstreamClient.getDailySnippetFeedback(true), (error: unknown) => {
    return error instanceof ThousandSchoolApiError && error.code === "UPSTREAM_ERROR" && !error.retryable;
  });
});
