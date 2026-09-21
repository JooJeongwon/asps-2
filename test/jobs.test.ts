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
          return { results: [{ stage: "FETCH", status: "SUCCEEDED", run_id: null, attempt_count: 1, safe_error_code: null, started_at: null, finished_at: null }] };
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

test("deleting a job removes steps before the scoped job row", async () => {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          return {};
        },
      };
    },
    batch: async () => statements.map((_, index) => ({ meta: { changes: index === 1 ? 1 : 2 } })),
  } as unknown as D1Database;

  assert.equal(await new JobRepository(db).delete("user-1", "job-1"), true);
  assert.match(statements[0].sql, /DELETE FROM job_steps/);
  assert.deepEqual(statements[0].args, ["user-1", "job-1"]);
  assert.match(statements[1].sql, /user_id = \? AND id = \?/);
  assert.deepEqual(statements[1].args, ["user-1", "job-1"]);
});

test("a redelivered queue message can resume its own running stage", async () => {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => ({
        run: async () => {
          statements.push({ sql, args });
          return { meta: { changes: sql.includes("UPDATE job_steps") ? 1 : 0 } };
        },
      }) };
    },
  } as unknown as D1Database;

  assert.equal(await new JobRepository(db).beginStage("user-1", "job-1", "AI_SUGGEST", "message-1"), true);
  assert.match(statements[0].sql, /status = 'RUNNING' AND run_id = \?/);
  assert.deepEqual(statements[0].args.slice(0, 1), ["message-1"]);
});

test("applying a legacy suggestion invalidates its old score", async () => {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => {
        statements.push({ sql, args });
        return {};
      } };
    },
    batch: async () => [],
  } as unknown as D1Database;

  await new JobRepository(db).resetAfterSuggestion("user-1", "job-1");
  assert.match(statements[0].sql, /stage IN \('AI_SCORE', 'SAVE'\)/);
  assert.deepEqual(statements[0].args, ["user-1", "job-1"]);
  assert.match(statements[1].sql, /status = 'AI_SUGGESTED'/);
  assert.deepEqual(statements[1].args.slice(1), ["user-1", "job-1"]);
});

test("an ambiguous AI result cannot be blindly retried", async () => {
  const db = {
    prepare() {
      return { bind: () => ({ first: async () => ({
        id: "job-1", user_id: "user-1", profile_id: "profile-1", notion_page_id: "page-1",
        target_date: "2026-09-21", mode: "FULL_AUTO", status: "FAILED_FINAL", content_hash: "a".repeat(64),
        remote_record_id: "101", attempt_count: 1, next_retry_at: null, last_error_code: "AI_RESULT_AMBIGUOUS",
        last_error_message: "unknown", created_at: "", updated_at: "",
      }) }) };
    },
  } as unknown as D1Database;

  await assert.rejects(new JobRepository(db).retry("user-1", "job-1"), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "AI_RESULT_AMBIGUOUS";
  });
});
