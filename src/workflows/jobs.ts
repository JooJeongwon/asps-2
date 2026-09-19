import { z } from "zod";
import { decryptCredential } from "../security/credentials";
import { JobRepository, type JobExecutionContext } from "../repositories/jobs";
import { NotionApiError, NotionClient } from "../services/notion/client";
import { hydrateBlockTree, toNotionDraft, type NotionPropertyMapping } from "../services/notion/blocks";
import type { NotionBlock } from "../services/notion/schemas";
import type { Env } from "../types/env";

const JobMessage = z.object({ userId: z.string().min(1), jobId: z.string().min(1), profileId: z.string().min(1) });
export type JobQueueMessage = z.infer<typeof JobMessage>;

function mapping(value: string): NotionPropertyMapping {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : undefined,
      date: typeof record.date === "string" ? record.date : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    };
  } catch {
    return {};
  }
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof NotionApiError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof Error && error.message === "Credential payload is invalid") return { code: "CREDENTIAL_INVALID", message: "Stored credential is invalid", retryable: false };
  return { code: "NOTION_FETCH_FAILED", message: "Notion fetch failed", retryable: false };
}

async function process(message: Message<unknown>, env: Env): Promise<void> {
  const parsed = JobMessage.safeParse(message.body);
  if (!parsed.success) {
    message.ack();
    return;
  }
  const { userId, jobId, profileId } = parsed.data;
  const jobs = new JobRepository(env.DB);
  const context = await jobs.executionContext(userId, jobId, profileId);
  if (!context) {
    message.ack();
    return;
  }
  if (context.job.status === "CANCELLED" || context.job.status === "SAVED") {
    message.ack();
    return;
  }
  if (!context.profileEnabled || context.notionStatus !== "ACTIVE" || context.accountStatus !== "ACTIVE" || context.notionCredentialStatus !== "ACTIVE" || context.accountCredentialStatus !== "ACTIVE") {
    await jobs.fail(userId, jobId, "PROFILE_INACTIVE", "Automation profile is inactive", false);
    message.ack();
    return;
  }
  if (!context.dataSourceId) {
    await jobs.fail(userId, jobId, "NOTION_DATA_SOURCE_REQUIRED", "Notion data source is not configured", false);
    message.ack();
    return;
  }
  if (!await jobs.beginFetch(userId, jobId)) {
    message.ack();
    return;
  }

  try {
    const payload = await decryptCredential({ keyVersion: context.credentialKeyVersion, iv: context.credentialIv, encryptedPayload: context.encryptedPayload }, env.CREDENTIAL_ENCRYPTION_KEY);
    if (typeof payload.token !== "string" || !payload.token) throw new Error("Credential payload is invalid");
    const client = new NotionClient({ token: payload.token, requestId: message.id });
    const page = await client.retrievePage(context.job.notionPageId);
    const blocks = await hydrateBlockTree(client, await client.listAllBlockChildren(context.job.notionPageId));
    const draft = await toNotionDraft(page, blocks, mapping(context.propertyMappingJson));
    if (draft.targetDate !== context.job.targetDate || draft.contentHash !== context.job.contentHash) {
      await jobs.fail(userId, jobId, "CONTENT_CHANGED", "Notion content changed after job creation", false);
      message.ack();
      return;
    }
    await jobs.completeFetch(userId, jobId);
    message.ack();
  } catch (error) {
    const failure = safeFailure(error);
    await jobs.fail(userId, jobId, failure.code, failure.message, failure.retryable);
    if (failure.retryable) message.retry({ delaySeconds: Math.min(300, Math.max(5, message.attempts * 15)) });
    else message.ack();
  }
}

export async function consumeJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) await process(message, env);
}
