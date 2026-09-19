import { HttpError } from "../lib/errors";

export type JobMode = "DRAFT_ONLY" | "SUGGEST" | "SCORE" | "SAVE" | "FULL_AUTO";
export type JobStatus = "PENDING" | "FETCHED" | "DRAFT_CREATED" | "AI_SUGGESTED" | "AI_SCORED" | "SAVED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "AUTH_REQUIRED" | "PROFILE_REQUIRED" | "CANCELLED";

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
      await this.db
        .prepare(
        `INSERT INTO job_steps (id, user_id, job_id, stage, status)
           VALUES (?, ?, ?, 'FETCH', 'PENDING')`,
        )
        .bind(crypto.randomUUID(), input.userId, createdJob.id)
        .run();
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

  async retry(userId: string, jobId: string): Promise<Job> {
    const current = await this.get(userId, jobId);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Not found");
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

  async beginFetch(userId: string, jobId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE job_steps SET status = 'RUNNING', attempt_count = attempt_count + 1, started_at = ?
         WHERE user_id = ? AND job_id = ? AND stage = 'FETCH' AND status IN ('PENDING', 'FAILED')`,
      )
      .bind(new Date().toISOString(), userId, jobId)
      .run();
    if (result.meta.changes !== 1) return false;
    await this.db
      .prepare("UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = ? WHERE user_id = ? AND id = ?")
      .bind(new Date().toISOString(), userId, jobId)
      .run();
    return true;
  }

  async completeFetch(userId: string, jobId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE job_steps SET status = 'SUCCEEDED', finished_at = ? WHERE user_id = ? AND job_id = ? AND stage = 'FETCH'").bind(now, userId, jobId),
      this.db.prepare("UPDATE jobs SET status = 'FETCHED', updated_at = ? WHERE user_id = ? AND id = ?").bind(now, userId, jobId),
    ]);
  }

  async fail(userId: string, jobId: string, code: string, message: string, retryable: boolean): Promise<void> {
    const now = new Date().toISOString();
    const status = code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
    await this.db.batch([
      this.db.prepare("UPDATE job_steps SET status = 'FAILED', safe_error_code = ?, finished_at = ? WHERE user_id = ? AND job_id = ? AND stage = 'FETCH'").bind(code, now, userId, jobId),
      this.db.prepare("UPDATE jobs SET status = ?, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE user_id = ? AND id = ?").bind(status, code, message, now, userId, jobId),
    ]);
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
                nc.iv AS credential_iv, nc.encrypted_payload
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
    };
  }
}
