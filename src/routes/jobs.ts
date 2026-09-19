import { z } from "zod";
import { HttpError } from "../lib/errors";
import { json, empty } from "../lib/http";
import { AuditRepository } from "../repositories/audit";
import { JobRepository, targetStageForMode, type JobMode, type JobTargetStage } from "../repositories/jobs";
import type { Env } from "../types/env";
import type { User } from "../types/domain";

const Mode = z.enum(["DRAFT_ONLY", "SUGGEST", "SCORE", "SAVE", "FULL_AUTO"]);
const Action = z.enum(["SUGGEST", "SCORE", "SAVE"]);
const CreateJobInput = z.object({
  profileId: z.string().min(1),
  notionPageId: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  mode: Mode,
});

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

function message(user: User, jobId: string, profileId: string, targetStage: JobTargetStage) {
  return { userId: user.id, jobId, profileId, targetStage };
}

export async function handleJobs(request: Request, env: Env, user: User): Promise<Response> {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  const repository = new JobRepository(env.DB);

  if (path.length === 2 && path[0] === "api" && path[1] === "jobs") {
    if (request.method === "GET") {
      const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
      return json(await repository.list(user.id, Number.isFinite(limit) ? limit : 50));
    }
    method(request, ["POST"]);
    const input = await body(request, CreateJobInput);
    const result = await repository.create({ ...input, userId: user.id, mode: input.mode as JobMode });
    if (result.created || ["PENDING", "FAILED_RETRYABLE"].includes(result.job.status)) {
      await env.JOB_QUEUE.send(message(user, result.job.id, result.job.profileId, targetStageForMode(result.job.mode)));
    }
    return json(result.job, { status: result.created ? 202 : 200 });
  }

  if (path[0] === "api" && path[1] === "jobs" && path.length === 3) {
    const jobId = decodeURIComponent(path[2]);
    if (request.method === "GET") {
      const job = await repository.getDetails(user.id, jobId);
      return job ? json(job) : json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }

  if (path[0] === "api" && path[1] === "jobs" && path.length === 4) {
    const jobId = decodeURIComponent(path[2]);
    const action = path[3];
    method(request, ["POST"]);
    if (action === "cancel") {
      const cancelled = await repository.cancel(user.id, jobId);
      return cancelled ? empty() : json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }
    if (action === "retry") {
      const job = await repository.retry(user.id, jobId);
      await env.JOB_QUEUE.send(message(user, job.id, job.profileId, targetStageForMode(job.mode)));
      return json(job, { status: 202 });
    }
    if (action === "action") {
      const parsed = await body(request, z.object({ action: Action }));
      const job = await repository.get(user.id, jobId);
      if (!job) return json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      if (job.status === "CANCELLED") throw new HttpError(409, "JOB_CANCELLED", "Job is cancelled");
      const targetStage: JobTargetStage = parsed.action === "SUGGEST"
        ? "AI_SUGGESTED"
        : parsed.action === "SCORE"
          ? "AI_SCORED"
          : "SAVED";
      if (job.status === "SAVED") return json(job);
      await env.JOB_QUEUE.send(message(user, job.id, job.profileId, targetStage));
      await new AuditRepository(env.DB).record({ userId: user.id, action: `JOB_${parsed.action}_REQUESTED`, targetType: "job", targetId: job.id });
      return json({ ...job, requestedStage: targetStage }, { status: 202 });
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Not found");
}
