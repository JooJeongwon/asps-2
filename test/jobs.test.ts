import assert from "node:assert/strict";
import test from "node:test";
import { JobRepository } from "../src/repositories/jobs.ts";

test("job details query steps in the current user's scope", async () => {
  let stepQuery = "";
  const db = {
    prepare(sql: string) {
      if (sql.includes("FROM jobs")) {
        return { bind: () => ({ first: async () => ({
          id: "job-1", user_id: "user-1", profile_id: "profile-1", notion_page_id: "page-1",
          target_date: "2026-09-19", mode: "DRAFT_ONLY", status: "FETCHED", content_hash: "a".repeat(64),
          remote_record_id: null, attempt_count: 1, next_retry_at: null, last_error_code: null,
          last_error_message: null, created_at: "2026-09-19T00:00:00.000Z", updated_at: "2026-09-19T00:00:01.000Z",
        }) }) };
      }
      stepQuery = sql;
      return { bind: (...args: unknown[]) => ({
        all: async () => {
          assert.deepEqual(args, ["user-1", "job-1"]);
          return { results: [{ stage: "FETCH", status: "SUCCEEDED", attempt_count: 1, safe_error_code: null, started_at: null, finished_at: null }] };
        },
      }) };
    },
  } as unknown as D1Database;

  const details = await new JobRepository(db).getDetails("user-1", "job-1");
  assert.equal(details?.steps[0]?.stage, "FETCH");
  assert.match(stepQuery, /user_id = \? AND job_id = \?/);
});

test("retryable failure stores the next retry time", async () => {
  let jobArgs: unknown[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.startsWith("UPDATE jobs")) jobArgs = args;
          return {};
        },
      };
    },
    batch: async () => [],
  } as unknown as D1Database;

  const before = Date.now() + 16_000;
  await new JobRepository(db).failStage("user-1", "job-1", "CREATE_DRAFT", "RATE_LIMITED", "retry", true, 17);
  const nextRetryAt = Date.parse(String(jobArgs[1]));
  assert.ok(nextRetryAt >= before && nextRetryAt <= Date.now() + 18_000);
});
