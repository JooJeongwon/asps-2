import { z } from "zod";
import { HttpError } from "../lib/errors";
import { json } from "../lib/http";
import { UserRepository } from "../repositories/users";
import { clearCookie, createOAuthAuthorization, createSession, OAUTH_STATE_COOKIE, SESSION_COOKIE, validateOAuthState, CSRF_COOKIE, issueCsrf } from "../auth/session";
import type { Env } from "../types/env";
import type { User } from "../types/domain";

const OAuthTokenSchema = z.object({ access_token: z.string().min(1) });
const OAuthUserSchema = z.object({
  sub: z.string().min(1),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const LOGIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASPS 로그인</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:24px;text-align:center}a{display:inline-block;padding:12px 18px;background:#17202a;color:#fff;border-radius:8px;text-decoration:none}</style></head><body><h1>ASPS</h1><p>Daily snippet 자동화를 시작하세요.</p><a href="/api/auth/login">로그인</a></body></html>`;

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, "AUTH_PROVIDER_INVALID", message);
  return result.data;
}

async function oauthJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new HttpError(502, "AUTH_PROVIDER_UNAVAILABLE", "Authentication provider is unavailable", { cause: error });
  }
  if (!response.ok) throw new HttpError(502, "AUTH_PROVIDER_ERROR", "Authentication provider rejected the request");
  try {
    return await response.json();
  } catch (error) {
    throw new HttpError(502, "AUTH_PROVIDER_INVALID", "Authentication provider returned an invalid response", { cause: error });
  }
}

function oauthConfig(env: Env): void {
  if (!env.OAUTH_TOKEN_URL || !env.OAUTH_USERINFO_URL || !env.OAUTH_CLIENT_ID || !env.OAUTH_REDIRECT_URI || !env.OAUTH_ISSUER) {
    throw new HttpError(500, "AUTH_NOT_CONFIGURED", "OAuth authentication is not configured");
  }
}

async function callback(request: Request, env: Env): Promise<Response> {
  oauthConfig(env);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) throw new HttpError(401, "AUTH_DENIED", "Authentication was cancelled");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "AUTH_INVALID", "Authentication response is incomplete");
  const { verifier } = await validateOAuthState(request, env, state);
  const tokenRequest = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    client_id: env.OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });
  if (env.OAUTH_CLIENT_SECRET) tokenRequest.set("client_secret", env.OAUTH_CLIENT_SECRET);
  const tokenData = parse(OAuthTokenSchema, await oauthJson(env.OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: tokenRequest,
  }), "OAuth token response is invalid");
  const identity = parse(OAuthUserSchema, await oauthJson(env.OAUTH_USERINFO_URL, {
    headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/json" },
  }), "OAuth identity response is invalid");
  const user = await new UserRepository(env.DB).upsertByAuthSubject({
    subject: `${env.OAUTH_ISSUER}:${identity.sub}`,
    email: identity.email ?? null,
    displayName: identity.name ?? null,
  });
  if (user.status !== "ACTIVE") throw new HttpError(403, "ACCOUNT_DISABLED", "Account disabled");
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", await createSession(user.id, env));
  headers.append("set-cookie", clearCookie(OAUTH_STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

export async function handleAuth(request: Request, env: Env, user?: User): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/login" && request.method === "GET") return new Response(LOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (path === "/api/auth/login" && request.method === "GET") {
    oauthConfig(env);
    const auth = await createOAuthAuthorization(env);
    return new Response(null, { status: 302, headers: { location: auth.location, "set-cookie": auth.cookie } });
  }
  if (path === "/api/auth/callback" && request.method === "GET") return callback(request, env);
  if (path === "/api/auth/csrf" && request.method === "GET") {
    if (!user) throw new HttpError(401, "AUTH_REQUIRED", "Authentication required");
    const result = issueCsrf(request);
    return json({ token: result.token }, { headers: { "set-cookie": result.cookie, "cache-control": "no-store" } });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const headers = new Headers();
    headers.append("set-cookie", clearCookie(SESSION_COOKIE));
    headers.append("set-cookie", clearCookie(CSRF_COOKIE));
    return new Response(null, { status: 204, headers });
  }
  throw new HttpError(404, "NOT_FOUND", "Not found");
}
