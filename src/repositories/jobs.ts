import { HttpError } from "../lib/errors";

export type JobMode = "DRAFT_ONLY" | "SUGGEST" | "SCORE" | "SAVE" | "FULL_AUTO";
export type JobStatus = "PENDING" | "FETCHED" | "DRAFT_CREATED" | "AI_SUGGESTED" | "AI_SCORED" | "SAVED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "AUTH_REQUIRED" | "PROFILE_REQUIRED" | "CANCELLED";
export type JobStepStage = "FETCH" | "CREATE_DRAFT" | "AI_SUGGEST" | "AI_SCORE" | "SAVE" | "NOTION_UPDATE";
export type JobStepStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type JobTargetStage = "DRAFT_CREATED" | "AI_SUGGESTED" | "AI_SCORED" | "SAVED";

export function targetStageForMode(mode: JobMode): JobTargetStage {
  if (mode === "DRAFT_ONLY") return "DRAFT_CREATED";
  if (mode === "SUGGEST") return "AI_SUGGESTED";
  if (mode === "SCORE") return "AI_SCORED";
  return "SAVED";
}

export interface Job {
  id: string;
  userId: string;
  profileId: string;
  notionPageId: string;
  targetDate: string;
  mode: JobMode;
  status: JobStatus;
  contentHash: string;
  remoteRecordId: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobStep {
  stage: JobStepStage;
  status: JobStepStatus;
  runId: string | null;
  attemptCount: number;
  outputRef: string | null;
  safeErrorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobDetails extends Job {
  steps: JobStep[];
}

export interface JobExecutionContext {
  job: Job;
  profileEnabled: boolean;
  profileDefaultMode: JobMode;
  notionStatus: string;
  accountStatus: string;
  notionCredentialStatus: string;
  accountCredentialStatus: string;
  dataSourceId: string | null;
  propertyMappingJson: string;
  credentialKeyVersion: number;
  credentialIv: string;
  encryptedPayload: string;
  schoolCredentialKeyVersion: number;
  schoolCredentialIv: string;
  schoolEncryptedPayload: string;
}

interface JobRow {
  id: string;
  user_id: string;
  profile_id: string;
  notion_page_id: string;
  target_date: string;
  mode: JobMode;
  status: JobStatus;
  content_hash: string;
  remote_record_id: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

function job(row: JobRow): Job {
  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    notionPageId: row.notion_page_id,
    targetDate: row.target_date,
    mode: row.mode,
    status: row.status,
    contentHash: row.content_hash,
    remoteRecordId: row.remote_record_id,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function step(row: {
  stage: JobStepStage;
  status: JobStepStatus;
  run_id: string | null;
  attempt_count: number;
  output_ref: string | null;
  safe_error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}): JobStep {
  return {
    stage: row.stage,
    status: row.status,
    runId: row.run_id,
    attemptCount: row.attempt_count,
    outputRef: row.output_ref,
    safeErrorCode: row.safe_error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class JobRepository {
  constructor(private readonly db: D1Database) {}

  async list(userId: string, limit = 50): Promise<Job[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, profile_id, notion_page_id, target_date, mode, status, content_hash,
                remote_record_id, attempt_count, next_retry_at, last_error_code, last_error_message,
                created_at, updated_at
         FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(userId, safeLimit)
      .all<JobRow>();
    return results.map(job);
  }

  async get(userId: string, jobId: string): Promise<Job | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, profile_id, notion_page_id, target_date, mode, status, content_hash,
                remote_record_id, attempt_count, next_retry_at, last_error_code, last_error_message,
                created_at, updated_at
         FROM jobs WHERE user_id = ? AND id = ?`,
      )
      .bind(userId, jobId)
      .first<JobRow>();
    return row ? job(row) : null;
  }

  async getWebhookTarget(connectionId: string, jobId: string): Promise<Job | null> {
    const row = await this.db
      .prepare(
        `SELECT j.id, j.user_id, j.profile_id, j.notion_page_id, j.target_date, j.mode, j.status, j.content_hash,
                j.remote_record_id, j.attempt_count, j.next_retry_at, j.last_error_code, j.last_error_message,
                j.created_at, j.updated_at
         FROM jobs j
         JOIN automation_profiles p ON p.id = j.profile_id AND p.user_id = j.user_id
         JOIN notion_connections n ON n.id = p.notion_connection_id AND n.user_id = p.user_id
         WHERE n.id = ? AND j.id = ?
         ORDER BY j.created_at DESC LIMIT 1`,
      )
      .bind(connectionId, jobId)
      .first<JobRow>();
    return row ? job(row) : null;
  }

  async getDetails(userId: string, jobId: string): Promise<JobDetails | null> {
    const current = await this.get(userId, jobId);
    if (!current) return null;
    const { results } = await this.db
      .prepare(
        `SELECT stage, status, run_id, attempt_count, output_ref, safe_error_code, started_at, finished_at
         FROM job_steps WHERE user_id = ? AND job_id = ?
         ORDER BY CASE stage
           WHEN 'FETCH' THEN 1 WHEN 'CREATE_DRAFT' THEN 2 WHEN 'AI_SUGGEST' THEN 3
           WHEN 'AI_SCORE' THEN 4 WHEN 'SAVE' THEN 5 WHEN 'NOTION_UPDATE' THEN 6
         END`,
      )
      .bind(userId, jobId)
      .all<Parameters<typeof step>[0]>();
    return { ...current, steps: results.map(step) };
  }

  async create(input: {
    userId: string;
    profileId: string;
    notionPageId: string;
    targetDate: string;
    contentHash: string;
    mode: JobMode;
  }): Promise<{ job: Job; created: boolean }> {
    const profile = await this.db
      .prepare(
        `SELECT p.id
         FROM automation_profiles p
         JOIN notion_connections n ON n.id = p.notion_connection_id AND n.user_id = p.user_id
         JOIN thousand_school_accounts a ON a.id = p.thousand_school_account_id AND a.user_id = p.user_id
         JOIN credentials nc ON nc.id = n.credential_id AND nc.user_id = n.user_id
         JOIN credentials ac ON ac.id = a.credential_id AND ac.user_id = a.user_id
         WHERE p.user_id = ? AND p.id = ? AND p.enabled = 1
           AND n.status = 'ACTIVE' AND a.status = 'ACTIVE'
           AND nc.status = 'ACTIVE' AND ac.status = 'ACTIVE'`,
      )
      .bind(input.userId, input.profileId)
      .first<{ id: string }>();
    if (!profile) throw new HttpError(400, "PROFILE_REQUIRED", "An active automation profile is required");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO jobs
         (id, user_id, profile_id, notion_page_id, target_date, mode, status, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
         ON CONFLICT (user_id, profile_id, notion_page_id, target_date, content_hash, mode) DO NOTHING`,
      )
      .bind(id, input.userId, input.profileId, input.notionPageId, input.targetDate, input.mode, input.contentHash, now, now)
      .run();

    const createdJob = await this.db
      .prepare(
        `SELECT id, user_id, profile_id, notion_page_id, target_date, mode, status, content_hash,
                remote_record_id, attempt_count, next_retry_at, last_error_code, last_error_message,
                created_at, updated_at
         FROM jobs
         WHERE user_id = ? AND profile_id = ? AND notion_page_id = ? AND target_date = ?
           AND content_hash = ? AND mode = ?`,
      )
      .bind(input.userId, input.profileId, input.notionPageId, input.targetDate, input.contentHash, input.mode)
      .first<JobRow>();
    if (!createdJob) throw new Error("Job could not be loaded after insert");

    if (result.meta.changes === 1) {
      await this.db.batch([
        ...(["FETCH", "CREATE_DRAFT", "AI_SUGGEST", "AI_SCORE", "SAVE"] as JobStepStage[]).map((stage) => this.db
          .prepare("INSERT INTO job_steps (id, user_id, job_id, stage, status) VALUES (?, ?, ?, ?, 'PENDING')")
          .bind(crypto.randomUUID(), input.userId, createdJob.id, stage)),
      ]);
    }
    return { job: job(createdJob), created: result.meta.changes === 1 };
  }

  async cancel(userId: string, jobId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE jobs SET status = 'CANCELLED', updated_at = ?
         WHERE user_id = ? AND id = ? AND status NOT IN ('SAVED', 'FAILED_FINAL', 'CANCELLED')`,
      )
      .bind(new Date().toISOString(), userId, jobId)
      .run();
    return result.meta.changes === 1;
  }

  async delete(userId: string, jobId: string): Promise<boolean> {
    const result = await this.db.batch([
      this.db.prepare("DELETE FROM job_steps WHERE user_id = ? AND job_id = ?").bind(userId, jobId),
      this.db.prepare("DELETE FROM jobs WHERE user_id = ? AND id = ?").bind(userId, jobId),
    ]);
    return result[1]?.meta.changes === 1;
  }

  async retry(userId: string, jobId: string): Promise<Job> {
    const current = await this.get(userId, jobId);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Not found");
    if (current.lastErrorCode === "AI_RESULT_AMBIGUOUS") {
      throw new HttpError(409, "AI_RESULT_AMBIGUOUS", "Inspect 1000.school before starting a new job");
    }
    if (!["FAILED_RETRYABLE", "FAILED_FINAL", "AUTH_REQUIRED"].includes(current.status)) {
      throw new HttpError(409, "JOB_NOT_RETRYABLE", "Job is not ready for retry");
    }
    await this.db.batch([
      this.db.prepare(
        `UPDATE jobs SET status = 'PENDING', next_retry_at = NULL, last_error_code = NULL,
         last_error_message = NULL, updated_at = ? WHERE user_id = ? AND id = ?`,
      ).bind(new Date().toISOString(), userId, jobId),
      this.db.prepare(
        `UPDATE job_steps SET status = 'PENDING', safe_error_code = NULL, finished_at = NULL
         WHERE user_id = ? AND job_id = ? AND status = 'FAILED'`,
      ).bind(userId, jobId),
    ]);
    const result = await this.get(userId, jobId);
    if (!result) throw new Error("Job could not be loaded after retry");
    return result;
  }

  async beginStage(userId: string, jobId: string, stage: JobStepStage, runId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE job_steps SET status = 'RUNNING', run_id = ?, attempt_count = attempt_count + 1, started_at = ?
         WHERE user_id = ? AND job_id = ? AND stage = ?
           AND (status IN ('PENDING', 'FAILED') OR (status = 'RUNNING' AND run_id = ?))`,
      )
      .bind(runId, new Date().toISOString(), userId, jobId, stage, runId)
      .run();
    if (result.meta.changes !== 1) return false;
    await this.db
      .prepare("UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = ? WHERE user_id = ? AND id = ?")
      .bind(new Date().toISOString(), userId, jobId)
      .run();
    return true;
  }

  async setStageOutput(userId: string, jobId: string, stage: JobStepStage, outputRef: string): Promise<void> {
    await this.db
      .prepare("UPDATE job_steps SET output_ref = ? WHERE user_id = ? AND job_id = ? AND stage = ?")
      .bind(outputRef, userId, jobId, stage)
      .run();
  }

  async resetAfterSuggestion(userId: string, jobId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE job_steps SET status = 'PENDING', output_ref = NULL, safe_error_code = NULL,
         run_id = NULL, started_at = NULL, finished_at = NULL
         WHERE user_id = ? AND job_id = ? AND stage IN ('AI_SCORE', 'SAVE')`,
      ).bind(userId, jobId),
      this.db.prepare("UPDATE jobs SET status = 'AI_SUGGESTED', updated_at = ? WHERE user_id = ? AND id = ?")
        .bind(now, userId, jobId),
    ]);
  }

  async completeStage(
    userId: string,
    jobId: string,
    stage: JobStepStage,
    status: JobStatus,
    outputRef: string | null = null,
    remoteRecordId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE job_steps SET status = 'SUCCEEDED', output_ref = ?, finished_at = ? WHERE user_id = ? AND job_id = ? AND stage = ?").bind(outputRef, now, userId, jobId, stage),
      this.db.prepare(`UPDATE jobs SET status = ?, next_retry_at = NULL, remote_record_id = COALESCE(?, remote_record_id), updated_at = ? WHERE user_id = ? AND id = ?`).bind(status, remoteRecordId ?? null, now, userId, jobId),
    ]);
  }

  async failStage(userId: string, jobId: string, stage: JobStepStage, code: string, message: string, retryable: boolean, retryAfterSeconds?: number): Promise<void> {
    const now = new Date().toISOString();
    const status = code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
    const nextRetryAt = retryable && retryAfterSeconds !== undefined
      ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
      : null;
    await this.db.batch([
      this.db.prepare("UPDATE job_steps SET status = 'FAILED', safe_error_code = ?, finished_at = ? WHERE user_id = ? AND job_id = ? AND stage = ?").bind(code, now, userId, jobId, stage),
      this.db.prepare("UPDATE jobs SET status = ?, next_retry_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE user_id = ? AND id = ?").bind(status, nextRetryAt, code, message, now, userId, jobId),
    ]);
  }

  async fail(userId: string, jobId: string, code: string, message: string, retryable: boolean): Promise<void> {
    await this.failStage(userId, jobId, "FETCH", code, message, retryable);
  }

  async setRemoteRecordId(userId: string, jobId: string, remoteRecordId: string): Promise<void> {
    await this.db
      .prepare("UPDATE jobs SET remote_record_id = ?, updated_at = ? WHERE user_id = ? AND id = ?")
      .bind(remoteRecordId, new Date().toISOString(), userId, jobId)
      .run();
  }

  async executionContext(userId: string, jobId: string, profileId: string): Promise<JobExecutionContext | null> {
    const row = await this.db
      .prepare(
        `SELECT j.id, j.user_id, j.profile_id, j.notion_page_id, j.target_date, j.mode, j.status,
                j.content_hash, j.remote_record_id, j.attempt_count, j.next_retry_at,
                j.last_error_code, j.last_error_message, j.created_at, j.updated_at,
                p.enabled AS profile_enabled, p.default_mode AS profile_default_mode,
                n.status AS notion_status, n.data_source_id, n.property_mapping_json,
                a.status AS account_status, nc.status AS notion_credential_status,
                ac.status AS account_credential_status, nc.key_version AS credential_key_version,
                nc.iv AS credential_iv, nc.encrypted_payload,
                ac.key_version AS school_credential_key_version,
                ac.iv AS school_credential_iv, ac.encrypted_payload AS school_encrypted_payload
         FROM jobs j
         JOIN automation_profiles p ON p.id = j.profile_id AND p.user_id = j.user_id
         JOIN notion_connections n ON n.id = p.notion_connection_id AND n.user_id = p.user_id
         JOIN thousand_school_accounts a ON a.id = p.thousand_school_account_id AND a.user_id = p.user_id
         JOIN credentials nc ON nc.id = n.credential_id AND nc.user_id = n.user_id
         JOIN credentials ac ON ac.id = a.credential_id AND ac.user_id = a.user_id
         WHERE j.user_id = ? AND j.id = ? AND j.profile_id = ?`,
      )
      .bind(userId, jobId, profileId)
      .first<JobRow & {
        profile_enabled: number;
        profile_default_mode: JobMode;
        notion_status: string;
        data_source_id: string | null;
        property_mapping_json: string;
        account_status: string;
        notion_credential_status: string;
        account_credential_status: string;
        credential_key_version: number;
        credential_iv: string;
        encrypted_payload: string;
        school_credential_key_version: number;
        school_credential_iv: string;
        school_encrypted_payload: string;
      }>();
    if (!row) return null;
    return {
      job: job(row),
      profileEnabled: row.profile_enabled === 1,
      profileDefaultMode: row.profile_default_mode,
      notionStatus: row.notion_status,
      accountStatus: row.account_status,
      notionCredentialStatus: row.notion_credential_status,
      accountCredentialStatus: row.account_credential_status,
      dataSourceId: row.data_source_id,
      propertyMappingJson: row.property_mapping_json,
      credentialKeyVersion: row.credential_key_version,
      credentialIv: row.credential_iv,
      encryptedPayload: row.encrypted_payload,
      schoolCredentialKeyVersion: row.school_credential_key_version,
      schoolCredentialIv: row.school_credential_iv,
      schoolEncryptedPayload: row.school_encrypted_payload,
    };
  }
}
