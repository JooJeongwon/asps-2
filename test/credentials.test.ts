import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential } from "../src/security/credentials.ts";

test("credential encryption round-trips without storing plaintext", async () => {
  const masterKey = btoa("0123456789abcdef0123456789abcdef");
  const encrypted = await encryptCredential({ token: "fixture-value" }, masterKey, 3);

  assert.equal(encrypted.keyVersion, 3);
  assert.ok(!encrypted.encryptedPayload.includes("fixture-value"));
  assert.deepEqual(await decryptCredential(encrypted, masterKey), { token: "fixture-value" });
});
