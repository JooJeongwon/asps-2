import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionRepository } from "../src/repositories/connections.ts";
import { JobRepository } from "../src/repositories/jobs.ts";
import { HttpError } from "../src/lib/errors.ts";

function database(first: (sql: string, args: unknown[]) => unknown): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => first(sql, args),
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

test("profile lookup does not return another user's record", async () => {
  const db = database((sql, args) => {
    assert.deepEqual(args, ["user-a", "profile-b"]);
    return sql.includes("WHERE user_id = ? AND id = ?")
      ? null
      : { id: "profile-b", name: "other user", notion_connection_id: "n-b", thousand_school_account_id: "s-b", default_mode: "DRAFT_ONLY", schedule_json: null, enabled: 1, created_at: "", updated_at: "" };
  });

  assert.equal(await new ConnectionRepository(db).getProfile("user-a", "profile-b"), null);
});

test("profile creation rejects connections owned by another user", async () => {
  const db = database((sql) => {
    if (sql.includes("FROM notion_connections") && sql.includes("user_id = ?")) {
      return { notion_id: null, account_id: null };
    }
    return { notion_id: "n-b", account_id: "s-b" };
  });

  await assert.rejects(
    () => new ConnectionRepository(db).createProfile("user-a", {
      name: "cross-user", notionConnectionId: "n-b", thousandSchoolAccountId: "s-b", defaultMode: "DRAFT_ONLY", schedule: null,
    }),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PROFILE",
  );
});

test("job lookup does not return another user's record", async () => {
  const db = database((sql, args) => {
    assert.deepEqual(args, ["user-a", "job-b"]);
    return sql.includes("WHERE user_id = ? AND id = ?")
      ? null
      : { id: "job-b", user_id: "user-b", profile_id: "profile-b", notion_page_id: "page-b", target_date: "2026-09-19", mode: "DRAFT_ONLY", status: "PENDING", content_hash: "a".repeat(64), remote_record_id: null, attempt_count: 0, next_retry_at: null, last_error_code: null, last_error_message: null, created_at: "", updated_at: "" };
  });

  assert.equal(await new JobRepository(db).get("user-a", "job-b"), null);
});
