import assert from "node:assert/strict";
import test from "node:test";
import { verifyWebhookSecret } from "../src/security/webhooks.ts";

test("webhook secret comparison accepts only the exact secret", async () => {
  assert.equal(await verifyWebhookSecret("secret", "secret"), true);
  assert.equal(await verifyWebhookSecret("secret", "wrong"), false);
  assert.equal(await verifyWebhookSecret("secret", undefined), false);
});
