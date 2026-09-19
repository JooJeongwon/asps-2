import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthAuthorization, requireCsrf } from "../src/auth/session.ts";
import type { Env } from "../src/types/env.ts";

const env = {
  SESSION_SECRET: "a-session-secret-long-enough-for-hs256-tests",
  OAUTH_ISSUER: "https://issuer.example.com",
  OAUTH_AUTHORIZATION_URL: "https://issuer.example.com/authorize",
  OAUTH_TOKEN_URL: "https://issuer.example.com/token",
  OAUTH_USERINFO_URL: "https://issuer.example.com/userinfo",
  OAUTH_CLIENT_ID: "client-id",
  OAUTH_CLIENT_SECRET: "client-secret",
  OAUTH_REDIRECT_URI: "https://app.example.com/api/auth/callback",
} as Env;

test("OAuth login uses PKCE and an HttpOnly state cookie", async () => {
  const result = await createOAuthAuthorization({ ...env, OAUTH_CLIENT_SECRET: undefined });
  const url = new URL(result.location);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.match(result.cookie, /asps_oauth_state=.*HttpOnly/);
});

test("browser mutations require the CSRF double-submit token", async () => {
  const request = new Request("https://app.example.com/api/jobs", { headers: { cookie: "asps_csrf=csrf-token", "x-csrf-token": "csrf-token" } });
  await requireCsrf(request);
  await assert.rejects(() => requireCsrf(new Request(request.url, { headers: { cookie: "asps_csrf=csrf-token", "x-csrf-token": "wrong" } })));
});
