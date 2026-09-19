import { z } from "zod";
import { HttpError } from "../lib/errors";
import { empty, json } from "../lib/http";
import { AuditRepository } from "../repositories/audit";
import { ConnectionRepository } from "../repositories/connections";
import type { Env } from "../types/env";
import type { User } from "../types/domain";

const NotionInput = z.object({
  token: z.string().min(1),
  databaseId: z.string().min(1),
  dataSourceId: z.string().min(1),
  workspaceRef: z.string().optional(),
  propertyMapping: z.record(z.string(), z.string()).default({}),
});

const ThousandSchoolInput = z.object({
  token: z.string().min(1),
  providerAccountRef: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

const Mode = z.enum(["DRAFT_ONLY", "SUGGEST", "SCORE", "SAVE", "FULL_AUTO"]);
const ProfileCreateInput = z.object({
  name: z.string().min(1).max(120),
  notionConnectionId: z.string().min(1),
  thousandSchoolAccountId: z.string().min(1),
  defaultMode: Mode.default("FULL_AUTO"),
  schedule: z.record(z.string(), z.unknown()).nullable().default(null),
});
const ProfileUpdateInput = ProfileCreateInput.partial().extend({ enabled: z.boolean().optional() });

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", "Request body is invalid");
  return parsed.data;
}

function method(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
}

export async function handleMe(request: Request, env: Env, user: User): Promise<Response> {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  const connections = new ConnectionRepository(env.DB);
  const audit = new AuditRepository(env.DB);

  if (path.length === 2 && path[0] === "api" && path[1] === "me") {
    method(request, ["GET"]);
    return json({ user: { id: user.id, email: user.email, displayName: user.displayName, status: user.status }, notion: await connections.getNotion(user.id), thousandSchool: await connections.getThousandSchool(user.id), profiles: await connections.listProfiles(user.id) });
  }

  if (path.length === 5 && path[0] === "api" && path[1] === "me" && path[2] === "connections" && path[3] === "notion" && path[4] === "webhook-verification-token") {
    method(request, ["GET"]);
    const token = await connections.getNotionWebhookVerificationTokenForUser(user.id, env.CREDENTIAL_ENCRYPTION_KEY);
    if (!token) return json({ error: { code: "NOT_FOUND", message: "Webhook verification token not found" } }, { status: 404 });
    await audit.record({ userId: user.id, action: "NOTION_WEBHOOK_VERIFICATION_TOKEN_VIEWED", targetType: "notion_connection" });
    return json({ verificationToken: token });
  }

  if (path[0] === "api" && path[1] === "me" && path[2] === "connections" && path.length === 4) {
    const kind = path[3];
    if (kind === "notion") {
      method(request, ["GET", "PUT", "DELETE"]);
      if (request.method === "GET") return json(await connections.getNotion(user.id));
      if (request.method === "DELETE") {
        const disabled = await connections.disableNotion(user.id);
        if (disabled) await audit.record({ userId: user.id, action: "CONNECTION_DISABLED", targetType: "notion_connection" });
        return empty();
      }
      const input = await body(request, NotionInput);
      const result = await connections.upsertNotion(user.id, input, env.CREDENTIAL_ENCRYPTION_KEY, keyVersion(env));
      await audit.record({ userId: user.id, action: "CONNECTION_UPDATED", targetType: "notion_connection", targetId: result.id });
      return json(result);
    }
    if (kind === "thousand-school") {
      method(request, ["GET", "PUT", "DELETE"]);
      if (request.method === "GET") return json(await connections.getThousandSchool(user.id));
      if (request.method === "DELETE") {
        const disabled = await connections.disableThousandSchool(user.id);
        if (disabled) await audit.record({ userId: user.id, action: "CONNECTION_DISABLED", targetType: "thousand_school_account" });
        return empty();
      }
      const input = await body(request, ThousandSchoolInput);
      const result = await connections.upsertThousandSchool(user.id, input, env.CREDENTIAL_ENCRYPTION_KEY, keyVersion(env));
      await audit.record({ userId: user.id, action: "CONNECTION_UPDATED", targetType: "thousand_school_account", targetId: result.id });
      return json(result);
    }
  }

  if (path[0] === "api" && path[1] === "me" && path[2] === "automation-profiles") {
    if (path.length === 3) {
      method(request, ["GET", "POST"]);
      if (request.method === "GET") return json(await connections.listProfiles(user.id));
      const result = await connections.createProfile(user.id, await body(request, ProfileCreateInput));
      await audit.record({ userId: user.id, action: "PROFILE_CREATED", targetType: "automation_profile", targetId: result.id });
      return json(result);
    }
    if (path.length === 4) {
      const profileId = decodeURIComponent(path[3]);
      method(request, ["GET", "PUT", "DELETE"]);
      if (request.method === "GET") {
        const profile = await connections.getProfile(user.id, profileId);
        return profile ? json(profile) : json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      }
      if (request.method === "DELETE") {
        const deleted = await connections.deleteProfile(user.id, profileId);
        if (deleted) await audit.record({ userId: user.id, action: "PROFILE_DELETED", targetType: "automation_profile", targetId: profileId });
        return deleted ? empty() : json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      }
      const input = await body(request, ProfileUpdateInput);
      if (input.enabled === false && Object.keys(input).length === 1) {
        const disabled = await connections.disableProfile(user.id, profileId);
        if (disabled) await audit.record({ userId: user.id, action: "PROFILE_DISABLED", targetType: "automation_profile", targetId: profileId });
        return disabled ? empty() : json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      }
      const result = await connections.updateProfile(user.id, profileId, input);
      await audit.record({ userId: user.id, action: "PROFILE_UPDATED", targetType: "automation_profile", targetId: profileId });
      return json(result);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Not found");
}

function keyVersion(env: Env): number {
  const version = Number.parseInt(env.CREDENTIAL_KEY_VERSION ?? "1", 10);
  if (!Number.isInteger(version) || version < 1) throw new HttpError(500, "KEY_CONFIG_INVALID", "Credential encryption is not configured");
  return version;
}
