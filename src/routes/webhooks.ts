import { z } from "zod";
import { HttpError } from "../lib/errors";
import { json } from "../lib/http";
import { JobRepository, type JobTargetStage } from "../repositories/jobs";
import { verifyWebhookSecret } from "../security/webhooks";
import type { Env } from "../types/env";

const WebhookInput = z
  .object({
    action: z.enum(["SUGGEST", "SCORE", "SAVE"]),
    jobId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.jobId), "jobId is required");

function targetStage(action: z.infer<typeof WebhookInput>["action"]): JobTargetStage {
  return action === "SUGGEST" ? "AI_SUGGESTED" : action === "SCORE" ? "AI_SCORED" : "SAVED";
}

export async function handleNotionWebhook(request: Request, env: Env, connectionId: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  if (!await verifyWebhookSecret(env.WEBHOOK_SIGNING_SECRET, request.headers.get("x-asps-webhook-secret"))) {
    throw new HttpError(401, "WEBHOOK_UNAUTHORIZED", "Webhook authentication failed");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = WebhookInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", "Webhook body is invalid");

  const job = await new JobRepository(env.DB).getWebhookTarget(connectionId, parsed.data.jobId!);
  if (!job) throw new HttpError(404, "NOT_FOUND", "Not found");
  if (job.status === "CANCELLED") throw new HttpError(409, "JOB_CANCELLED", "Job is cancelled");
  if (job.status === "SAVED") return json({ jobId: job.id, status: job.status });

  const requestedStage = targetStage(parsed.data.action);
  await env.JOB_QUEUE.send({ userId: job.userId, jobId: job.id, profileId: job.profileId, targetStage: requestedStage });
  return json({ jobId: job.id, requestedStage }, { status: 202 });
}
