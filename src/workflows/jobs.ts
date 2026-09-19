import { z } from "zod";
import { decryptCredential } from "../security/credentials";
import { ConnectionRepository } from "../repositories/connections";
import { JobRepository, type JobStep, type JobStepStage, type JobTargetStage, targetStageForMode } from "../repositories/jobs";
import { NotionApiError, NotionClient } from "../services/notion/client";
import {
  hydrateBlockTree,
  notionResultProperties,
  toNotionDraft,
  type NotionPropertyMapping,
} from "../services/notion/blocks";
import { ThousandSchoolApiError, ThousandSchoolClient } from "../services/thousand-school/client";
import {
  ensureDraft,
  requestScore,
  requestSuggestion,
  saveDraft,
  WorkflowContractError,
} from "./thousand-school";
import type { Env } from "../types/env";

const JobMessage = z.object({
  userId: z.string().min(1),
  jobId: z.string().min(1),
  profileId: z.string().min(1),
  targetStage: z.enum(["DRAFT_CREATED", "AI_SUGGESTED", "AI_SCORED", "SAVED"]).optional(),
});
export type JobQueueMessage = z.infer<typeof JobMessage>;

const stageRank: Record<JobTargetStage, number> = {
  DRAFT_CREATED: 1,
  AI_SUGGESTED: 2,
  AI_SCORED: 3,
  SAVED: 4,
};

function needs(target: JobTargetStage, stage: JobTargetStage): boolean {
  return stageRank[target] >= stageRank[stage];
}

function mapping(value: string): NotionPropertyMapping {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : undefined,
      date: typeof record.date === "string" ? record.date : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
      jobId: typeof record.jobId === "string" ? record.jobId : undefined,
      remoteId: typeof record.remoteId === "string" ? record.remoteId : undefined,
      suggestion: typeof record.suggestion === "string" ? record.suggestion : undefined,
      score: typeof record.score === "string" ? record.score : undefined,
      lastError: typeof record.lastError === "string" ? record.lastError : undefined,
    };
  } catch {
    return {};
  }
}

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean; retryAfter?: number } {
  if (error instanceof NotionApiError || error instanceof ThousandSchoolApiError) {
    return { code: error.code, message: error.message, retryable: error.retryable, retryAfter: error.retryAfter };
  }
  if (error instanceof WorkflowContractError) {
    return { code: "WORKFLOW_CONTRACT_INVALID", message: error.message, retryable: false };
  }
  if (error instanceof Error && error.message === "Credential payload is invalid") {
    return { code: "CREDENTIAL_INVALID", message: "Stored credential is invalid", retryable: false };
  }
  return { code: "WORKFLOW_FAILED", message: "Automation workflow failed", retryable: false };
}

function retryDelaySeconds(retryAfter: number | undefined, attempts: number): number {
  if (retryAfter !== undefined) return Math.min(300, Math.max(1, retryAfter));
  const backoff = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
  return Math.min(300, Math.max(1, Math.ceil(backoff * (0.5 + Math.random()))));
}

function output(step: JobStep | undefined): Record<string, unknown> {
  if (!step?.outputRef) return {};
  try {
    const value: unknown = JSON.parse(step.outputRef);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOutput(step: JobStep | undefined, key: string): string | undefined {
  const value = output(step)[key];
  return typeof value === "string" ? value : undefined;
}

async function updatePage(
  client: NotionClient,
  page: Parameters<typeof notionResultProperties>[0],
  propertyMapping: NotionPropertyMapping,
  values: Parameters<typeof notionResultProperties>[2],
): Promise<void> {
  const properties = notionResultProperties(page, propertyMapping, values);
  if (Object.keys(properties).length) await client.updatePage(page.id, properties);
}

async function process(message: Message<unknown>, env: Env): Promise<void> {
  const parsed = JobMessage.safeParse(message.body);
  if (!parsed.success) {
    message.ack();
    return;
  }

  const { userId, jobId, profileId } = parsed.data;
  const jobs = new JobRepository(env.DB);
  const connections = new ConnectionRepository(env.DB);
  const context = await jobs.executionContext(userId, jobId, profileId);
  if (!context || context.job.status === "CANCELLED" || context.job.status === "SAVED") {
    message.ack();
    return;
  }

  const targetStage = parsed.data.targetStage ?? targetStageForMode(context.job.mode);
  const propertyMapping = mapping(context.propertyMappingJson);
  if (!context.profileEnabled || context.notionStatus !== "ACTIVE" || context.accountStatus !== "ACTIVE" || context.notionCredentialStatus !== "ACTIVE" || context.accountCredentialStatus !== "ACTIVE") {
    const authRequired = [context.notionStatus, context.accountStatus, context.notionCredentialStatus, context.accountCredentialStatus].includes("AUTH_REQUIRED");
    await jobs.fail(userId, jobId, authRequired ? "AUTH_REQUIRED" : "PROFILE_INACTIVE", authRequired ? "Connection authentication required" : "Automation profile is inactive", false);
    message.ack();
    return;
  }
  if (!context.dataSourceId) {
    await jobs.fail(userId, jobId, "NOTION_DATA_SOURCE_REQUIRED", "Notion data source is not configured", false);
    message.ack();
    return;
  }

  let page: Awaited<ReturnType<NotionClient["retrievePage"]>> | undefined;
  let draft: Awaited<ReturnType<typeof toNotionDraft>> | undefined;
  let notionClient: NotionClient | undefined;

  const fail = async (stage: JobStepStage, error: unknown): Promise<void> => {
    const failure = safeFailure(error);
    const delaySeconds = failure.retryable ? retryDelaySeconds(failure.retryAfter, message.attempts) : undefined;
    if (failure.code === "AUTH_REQUIRED") {
      if (error instanceof NotionApiError) await connections.markNotionAuthRequired(userId, profileId);
      if (error instanceof ThousandSchoolApiError) await connections.markThousandSchoolAuthRequired(userId, profileId);
    }
    await jobs.failStage(userId, jobId, stage, failure.code, failure.message, failure.retryable, delaySeconds);
    if (page && notionClient && failure.code !== "AUTH_REQUIRED") {
      try {
        await updatePage(notionClient, page, propertyMapping, { status: "오류", lastError: failure.code });
      } catch {
        // Keep the original workflow failure; the page update is best effort.
      }
    }
    if (delaySeconds !== undefined) message.retry({ delaySeconds });
    else message.ack();
  };

  try {
    notionClient = await notionClientFor(context, env, message.id);
  } catch (error) {
    await fail("FETCH", error);
    return;
  }

  try {
    const details = await jobs.getDetails(userId, jobId);
    const fetchStep = details?.steps.find((step) => step.stage === "FETCH");
    if (fetchStep?.status !== "SUCCEEDED") {
      if (!await jobs.beginStage(userId, jobId, "FETCH")) {
        message.ack();
        return;
      }
    }

    const blocks = await hydrateBlockTree(notionClient, await notionClient.listAllBlockChildren(context.job.notionPageId));
    page = await notionClient.retrievePage(context.job.notionPageId);
    draft = await toNotionDraft(page, blocks, propertyMapping);
    if (draft.targetDate !== context.job.targetDate || draft.contentHash !== context.job.contentHash) {
      await jobs.failStage(userId, jobId, "FETCH", "CONTENT_CHANGED", "Notion content changed after job creation", false);
      message.ack();
      return;
    }
    if (fetchStep?.status !== "SUCCEEDED") {
      await jobs.completeStage(userId, jobId, "FETCH", "FETCHED", JSON.stringify({ contentHash: draft.contentHash }));
    }
  } catch (error) {
    await fail("FETCH", error);
    return;
  }

  let schoolClient: ThousandSchoolClient;
  try {
    schoolClient = await schoolClientFor(context, env, message.id);
  } catch (error) {
    await fail("CREATE_DRAFT", error);
    return;
  }
  let current = await jobs.getDetails(userId, jobId);
  let remoteRecordId = context.job.remoteRecordId ?? stringOutput(current?.steps.find((step) => step.stage === "CREATE_DRAFT"), "remoteRecordId") ?? null;
  let suggestion = stringOutput(current?.steps.find((step) => step.stage === "AI_SUGGEST"), "suggestion");

  if (needs(targetStage, "DRAFT_CREATED")) {
    const createStep = current?.steps.find((step) => step.stage === "CREATE_DRAFT");
    if (createStep?.status !== "SUCCEEDED") {
      if (!await jobs.beginStage(userId, jobId, "CREATE_DRAFT")) {
        message.ack();
        return;
      }
      try {
        const result = await ensureDraft(schoolClient, {
          content: draft!.content,
          targetDate: context.job.targetDate,
          remoteRecordId,
        });
        remoteRecordId = String(result.id);
        await jobs.setRemoteRecordId(userId, jobId, remoteRecordId);
        await updatePage(notionClient, page!, propertyMapping, { status: "처리중", jobId, remoteId: remoteRecordId, lastError: "" });
        await jobs.completeStage(userId, jobId, "CREATE_DRAFT", "DRAFT_CREATED", JSON.stringify({ remoteRecordId }), remoteRecordId);
      } catch (error) {
        await fail("CREATE_DRAFT", error);
        return;
      }
    }
  }

  if (!needs(targetStage, "AI_SUGGESTED")) {
    message.ack();
    return;
  }

  current = await jobs.getDetails(userId, jobId);
  const suggestionStep = current?.steps.find((step) => step.stage === "AI_SUGGEST");
  if (suggestionStep?.status !== "SUCCEEDED") {
    if (!await jobs.beginStage(userId, jobId, "AI_SUGGEST")) {
      message.ack();
      return;
    }
    try {
      suggestion = await requestSuggestion(schoolClient, draft!.content, context.job.targetDate);
      await updatePage(notionClient, page!, propertyMapping, { status: "처리중", suggestion, lastError: "" });
      await jobs.completeStage(userId, jobId, "AI_SUGGEST", "AI_SUGGESTED", JSON.stringify({ suggestion }));
    } catch (error) {
      await fail("AI_SUGGEST", error);
      return;
    }
  }

  if (!needs(targetStage, "AI_SCORED")) {
    message.ack();
    return;
  }

  current = await jobs.getDetails(userId, jobId);
  const scoreStep = current?.steps.find((step) => step.stage === "AI_SCORE");
  if (scoreStep?.status !== "SUCCEEDED") {
    if (!await jobs.beginStage(userId, jobId, "AI_SCORE")) {
      message.ack();
      return;
    }
    try {
      const score = await requestScore(schoolClient, context.job.targetDate);
      await updatePage(notionClient, page!, propertyMapping, { status: "처리중", score, lastError: "" });
      await jobs.completeStage(userId, jobId, "AI_SCORE", "AI_SCORED", JSON.stringify({ score }));
    } catch (error) {
      await fail("AI_SCORE", error);
      return;
    }
  }

  if (!needs(targetStage, "SAVED")) {
    message.ack();
    return;
  }
  if (!remoteRecordId || suggestion === undefined) {
    await fail("SAVE", new WorkflowContractError("Draft and AI suggestion are required before save"));
    return;
  }

  current = await jobs.getDetails(userId, jobId);
  const saveStep = current?.steps.find((step) => step.stage === "SAVE");
  if (saveStep?.status !== "SUCCEEDED") {
    if (!await jobs.beginStage(userId, jobId, "SAVE")) {
      message.ack();
      return;
    }
    try {
      const result = await saveDraft(schoolClient, remoteRecordId, suggestion, context.job.targetDate);
      await updatePage(notionClient, page!, propertyMapping, { status: "완료", remoteId: String(result.id), lastError: "" });
      await jobs.completeStage(userId, jobId, "SAVE", "SAVED", JSON.stringify({ remoteRecordId: String(result.id), content: result.content }), String(result.id));
    } catch (error) {
      await fail("SAVE", error);
      return;
    }
  }
  message.ack();
}

async function notionClientFor(context: Awaited<ReturnType<JobRepository["executionContext"]>> & {}, env: Env, requestId: string): Promise<NotionClient> {
  if (!context) throw new Error("Job context is missing");
  const payload = await decryptCredential({ keyVersion: context.credentialKeyVersion, iv: context.credentialIv, encryptedPayload: context.encryptedPayload }, env.CREDENTIAL_ENCRYPTION_KEY);
  if (typeof payload.token !== "string" || !payload.token) throw new Error("Credential payload is invalid");
  return new NotionClient({ token: payload.token, requestId });
}

async function schoolClientFor(context: NonNullable<Awaited<ReturnType<JobRepository["executionContext"]>>>, env: Env, requestId: string): Promise<ThousandSchoolClient> {
  const payload = await decryptCredential({ keyVersion: context.schoolCredentialKeyVersion, iv: context.schoolCredentialIv, encryptedPayload: context.schoolEncryptedPayload }, env.CREDENTIAL_ENCRYPTION_KEY);
  if (typeof payload.token !== "string" || !payload.token) throw new Error("Credential payload is invalid");
  return new ThousandSchoolClient({
    baseUrl: "https://api.1000.school",
    headers: { authorization: `Bearer ${payload.token}` },
    requestId,
  });
}

export async function consumeJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) await process(message, env);
}
