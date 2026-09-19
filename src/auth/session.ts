import { jwtVerify, SignJWT } from "jose";
import { HttpError } from "../lib/errors";
import { UserRepository } from "../repositories/users";
import type { Env } from "../types/env";
import type { User } from "../types/domain";

export const SESSION_COOKIE = "asps_session";
export const OAUTH_STATE_COOKIE = "asps_oauth_state";
export const CSRF_COOKIE = "asps_csrf";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

const encoder = new TextEncoder();

function secret(value: string): Uint8Array {
  if (!value) throw new HttpError(500, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  return encoder.encode(value);
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sign(payload: Record<string, unknown>, env: Env, maxAge: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .sign(secret(env.SESSION_SECRET));
}

function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function setCookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; sameSite?: "Lax" | "Strict" }): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    `SameSite=${options.sameSite ?? "Lax"}`,
    options.httpOnly ? "HttpOnly" : "",
    options.maxAge === undefined ? "" : `Max-Age=${options.maxAge}`,
  ].filter(Boolean).join("; ");
}

export function clearCookie(name: string): string {
  return setCookie(name, "", { maxAge: 0 });
}

export async function createOAuthAuthorization(env: Env): Promise<{ location: string; cookie: string }> {
  if (!env.OAUTH_AUTHORIZATION_URL || !env.OAUTH_CLIENT_ID || !env.OAUTH_REDIRECT_URI) {
    throw new HttpError(500, "AUTH_NOT_CONFIGURED", "OAuth authentication is not configured");
  }

  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  const signedState = await sign({ state, verifier }, env, 600);
  const url = new URL(env.OAUTH_AUTHORIZATION_URL);
  url.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { location: url.toString(), cookie: setCookie(OAUTH_STATE_COOKIE, signedState, { httpOnly: true, maxAge: 600 }) };
}

export async function authenticate(request: Request, env: Env): Promise<User> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "AUTH_REQUIRED", "Authentication required");

  try {
    const { payload } = await jwtVerify(token, secret(env.SESSION_SECRET), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Session subject is missing");
    const user = await new UserRepository(env.DB).getById(payload.sub);
    if (!user) throw new HttpError(401, "AUTH_INVALID", "Authentication failed");
    if (user.status !== "ACTIVE") throw new HttpError(403, "ACCOUNT_DISABLED", "Account disabled");
    return user;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "AUTH_INVALID", "Authentication failed", { cause: error });
  }
}

export async function createSession(userId: string, env: Env): Promise<string> {
  return setCookie(SESSION_COOKIE, await sign({ sub: userId }, env, SESSION_MAX_AGE), { httpOnly: true, maxAge: SESSION_MAX_AGE });
}

export async function validateOAuthState(request: Request, env: Env, state: string): Promise<{ verifier: string }> {
  const token = cookie(request, OAUTH_STATE_COOKIE);
  if (!token || !state) throw new HttpError(401, "AUTH_INVALID", "Authentication failed");
  try {
    const { payload } = await jwtVerify(token, secret(env.SESSION_SECRET), { algorithms: ["HS256"] });
    if (payload.state !== state || typeof payload.verifier !== "string" || !payload.verifier) throw new Error("OAuth state mismatch");
    return { verifier: payload.verifier };
  } catch (error) {
    throw new HttpError(401, "AUTH_INVALID", "Authentication failed", { cause: error });
  }
}

export function csrfToken(request: Request): string | null {
  return cookie(request, CSRF_COOKIE);
}

export async function requireCsrf(request: Request): Promise<void> {
  const header = request.headers.get("x-csrf-token");
  const expected = csrfToken(request);
  if (!header || !expected || header.length !== expected.length) throw new HttpError(403, "CSRF_INVALID", "Request verification failed");
  let difference = 0;
  for (let index = 0; index < header.length; index += 1) difference |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  if (difference !== 0) throw new HttpError(403, "CSRF_INVALID", "Request verification failed");
}

export function issueCsrf(request: Request): { token: string; cookie: string } {
  const existing = csrfToken(request) ?? randomToken();
  return { token: existing, cookie: setCookie(CSRF_COOKIE, existing, { maxAge: SESSION_MAX_AGE, sameSite: "Strict" }) };
}
