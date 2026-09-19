import assert from "node:assert/strict";
import test from "node:test";
import { handleApp } from "../src/routes/app.ts";

test("dashboard is an authenticated, non-cacheable HTML response", async () => {
  const response = handleApp(new Request("https://example.com/"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /사용자별 Daily snippet 자동화/);
});
