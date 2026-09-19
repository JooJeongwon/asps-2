import { z } from "zod";
import { HttpError } from "../lib/errors";
import { json } from "../lib/http";
import { ConnectionRepository } from "../repositories/connections";
import { JobRepository, targetStageForMode, type JobMode } from "../repositories/jobs";
import { NotionApiError, NotionClient } from "../services/notion/client";
import { hydrateBlockTree, notionResultProperties, toNotionDraft } from "../services/notion/blocks";
import type { User } from "../types/domain";
import type { Env } from "../types/env";

const SyncInput = z.object({ profileId: z.string().min(1) });

async function input(request: Request): Promise<{ profileId: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = SyncInput.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", "Request body is invalid");
  return parsed.data;
}

function notionError(error: NotionApiError): HttpError {
  if (error.code === "AUTH_REQUIRED") return new HttpError(401, "AUTH_REQUIRED", "Notion authentication required");
  return new HttpError(502, "NOTION_SYNC_FAILED", "Notion sync failed", { cause: error });
}

export async function handleNotionSync(request: Request, env: Env, user: User, requestId: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  const { profileId } = await input(request);
  const connections = new ConnectionRepository(env.DB);
  const profile = await connections.getProfile(user.id, profileId);
  if (!profile) throw new HttpError(404, "NOT_FOUND", "Not found");
  const runtime = await connections.getNotionRuntime(user.id, profileId, env.CREDENTIAL_ENCRYPTION_KEY);
  if (!runtime.propertyMapping.status) throw new HttpError(400, "NOTION_STATUS_REQUIRED", "Notion status property is not configured");

  const client = new NotionClient({ token: runtime.token, requestId });
  const jobs = new JobRepository(env.DB);
  const result = { profileId, scanned: 0, queued: 0, existing: 0, skipped: 0, warnings: [] as Array<{ pageId: string; code: string }> };

  try {
    // ponytail: scan pages client-side because mapping does not record select vs status; add a Notion filter when the type is stored.
    for (const page of await client.listAllPages(runtime.dataSourceId)) {
      result.scanned += 1;
      const blocks = await hydrateBlockTree(client, await client.listAllBlockChildren(page.id));
      const draft = await toNotionDraft(page, blocks, runtime.propertyMapping);
      if (draft.status !== "전송대기" || draft.warnings.includes("missing_date_property") || draft.warnings.includes("empty_content") || draft.warnings.includes("unsupported_block")) {
        result.skipped += 1;
        const warnings = draft.status === "전송대기" ? draft.warnings : ["status_not_ready", ...draft.warnings];
        for (const code of warnings) result.warnings.push({ pageId: page.id, code });
        continue;
      }
      const created = await jobs.create({
        userId: user.id,
        profileId,
        notionPageId: page.id,
        targetDate: draft.targetDate!,
        contentHash: draft.contentHash,
        mode: profile.defaultMode as JobMode,
      });
      const jobProperties = notionResultProperties(page, runtime.propertyMapping, { jobId: created.job.id });
      if (Object.keys(jobProperties).length) await client.updatePage(page.id, jobProperties);
      if (created.created || ["PENDING", "FAILED_RETRYABLE"].includes(created.job.status)) {
        await env.JOB_QUEUE.send({ userId: user.id, jobId: created.job.id, profileId, targetStage: targetStageForMode(created.job.mode) });
        result.queued += 1;
      } else {
        result.existing += 1;
      }
    }
  } catch (error) {
    if (error instanceof NotionApiError) {
      if (error.code === "AUTH_REQUIRED") await connections.markNotionAuthRequired(user.id, profileId);
      throw notionError(error);
    }
    throw error;
  }

  return json(result, { status: 202 });
}
