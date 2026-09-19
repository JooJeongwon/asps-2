import assert from "node:assert/strict";
import test from "node:test";
import { verifyNotionWebhookSignature, verifyWebhookSecret } from "../src/security/webhooks.ts";

test("webhook secret comparison accepts only the exact secret", async () => {
  assert.equal(await verifyWebhookSecret("secret", "secret"), true);
  assert.equal(await verifyWebhookSecret("secret", "wrong"), false);
  assert.equal(await verifyWebhookSecret("secret", undefined), false);
});

test("Notion webhook signatures cover the raw request body", async () => {
  const body = JSON.stringify({ type: "page.properties_updated", entity: { type: "page", id: "page-1" } });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("verification-token"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const signature = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  assert.equal(await verifyNotionWebhookSignature(body, signature, "verification-token"), true);
  assert.equal(await verifyNotionWebhookSignature(`${body} `, signature, "verification-token"), false);
});
