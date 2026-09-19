import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { HttpError } from "../lib/errors";
import { UserRepository } from "../repositories/users";
import type { Env } from "../types/env";
import type { User } from "../types/domain";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySets.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url));
  keySets.set(url, created);
  return created;
}

function claim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function authenticate(request: Request, env: Env): Promise<User> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new HttpError(401, "AUTH_REQUIRED", "Authentication required");
  if (!env.AUTH_ISSUER || !env.AUTH_AUDIENCE || !env.AUTH_JWKS_URL) {
    throw new HttpError(500, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  }

  try {
    const { payload } = await jwtVerify(assertion, keySet(env.AUTH_JWKS_URL), {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      algorithms: ["RS256"],
    });
    if (!payload.sub) throw new Error("JWT subject is missing");

    const user = await new UserRepository(env.DB).upsertByAuthSubject({
      subject: payload.sub,
      email: claim(payload, "email"),
      displayName: claim(payload, "name"),
    });
    if (user.status !== "ACTIVE") throw new HttpError(403, "ACCOUNT_DISABLED", "Account disabled");
    return user;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "AUTH_INVALID", "Authentication failed", { cause: error });
  }
}
