import { z } from "zod";
import { HttpError } from "../lib/errors";
import { json } from "../lib/http";
import { ConnectionRepository } from "../repositories/connections";
import { JobRepository, type JobTargetStage } from "../repositories/jobs";
import { verifyNotionWebhookSignature, verifyWebhookSecret } from "../security/webhooks";
import type { Env } from "../types/env";

const WebhookInput = z
  .object({
    action: z.enum(["SUGGEST", "SCORE", "SAVE"]),
    jobId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.jobId), "jobId is required");
const NotionVerificationInput = z.object({ verification_token: z.string().min(1) });
const NotionEventInput = z.object({
  type: z.enum(["page.created", "page.properties_updated", "page.content_updated"]),
  entity: z.object({ type: z.literal("page"), id: z.string().min(1) }),
}).passthrough();

function targetStage(action: z.infer<typeof WebhookInput>["action"]): JobTargetStage {
  return action === "SUGGEST" ? "AI_SUGGESTED" : action === "SCORE" ? "AI_SCORED" : "SAVED";
}

export async function handleNotionWebhook(request: Request, env: Env, connectionId: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  let raw: unknown;
  const body = await request.text();
  try {
    raw = JSON.parse(body);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (request.headers.get("x-asps-webhook-secret")) {
    if (!await verifyWebhookSecret(env.WEBHOOK_SIGNING_SECRET, request.headers.get("x-asps-webhook-secret"))) {
      throw new HttpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed");
    }
    const parsed = WebhookInput.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", "Webhook body is invalid");

    const job = await new JobRepository(env.DB).getWebhookTarget(connectionId, parsed.data.jobId!);
    if (!job) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (job.status === "CANCELLED") throw new HttpError(409, "JOB_CANCELLED", "Job is cancelled");
    if (job.lastErrorCode === "AI_RESULT_AMBIGUOUS") throw new HttpError(409, "AI_RESULT_AMBIGUOUS", "Inspect 1000.school before starting a new job");
    if (job.status === "SAVED") return json({ jobId: job.id, status: job.status });

    const requestedStage = targetStage(parsed.data.action);
    await env.JOB_QUEUE.send({ userId: job.userId, jobId: job.id, profileId: job.profileId, targetStage: requestedStage });
    return json({ jobId: job.id, requestedStage }, { status: 202 });
  }

  const verification = NotionVerificationInput.safeParse(raw);
  const connections = new ConnectionRepository(env.DB);
  if (verification.success) {
    if (!await verifyNotionWebhookSignature(body, request.headers.get("x-notion-signature"), verification.data.verification_token)) {
      throw new HttpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed");
    }
    if (!await connections.storeNotionWebhookVerificationToken(connectionId, verification.data.verification_token, env.CREDENTIAL_ENCRYPTION_KEY, keyVersion(env))) {
      throw new HttpError(404, "NOT_FOUND", "Not found");
    }
    return json({ verified: true });
  }

  const verificationToken = await connections.getNotionWebhookVerificationToken(connectionId, env.CREDENTIAL_ENCRYPTION_KEY);
  if (!await verifyNotionWebhookSignature(body, request.headers.get("x-notion-signature"), verificationToken ?? "")) {
    throw new HttpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed");
  }
  const event = NotionEventInput.safeParse(raw);
  if (!event.success) throw new HttpError(400, "INVALID_INPUT", "Webhook body is invalid");
  const profiles = await connections.listWebhookProfiles(connectionId);
  for (const { userId, profile } of profiles) {
    await env.JOB_QUEUE.send({ type: "NOTION_PAGE_UPDATED", userId, profileId: profile.id, pageId: event.data.entity.id });
  }
  return json({ queued: profiles.length }, { status: 202 });
}

function keyVersion(env: Env): number {
  const version = Number.parseInt(env.CREDENTIAL_KEY_VERSION ?? "1", 10);
  if (!Number.isInteger(version) || version < 1) throw new HttpError(500, "KEY_CONFIG_INVALID", "Credential encryption is not configured");
  return version;
}
