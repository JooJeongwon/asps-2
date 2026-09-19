import { HttpError } from "../lib/errors";
import { decryptCredential, encryptCredential } from "../security/credentials";
import type { NotionPropertyMapping } from "../services/notion/blocks";

interface ConnectionRow {
  id: string;
  workspace_ref?: string | null;
  database_id?: string;
  data_source_id?: string | null;
  property_mapping_json?: string;
  provider_account_ref?: string | null;
  status: string;
  credential_status: string;
  updated_at: string;
}

export interface ConnectionView {
  id: string;
  status: string;
  credentialStatus: string;
  updatedAt: string;
  workspaceRef?: string | null;
  databaseId?: string;
  dataSourceId?: string | null;
  propertyMapping?: Record<string, string>;
  providerAccountRef?: string | null;
}

export interface AutomationProfile {
  id: string;
  name: string;
  notionConnectionId: string;
  thousandSchoolAccountId: string;
  defaultMode: string;
  schedule: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotionRuntime {
  dataSourceId: string;
  token: string;
  propertyMapping: NotionPropertyMapping;
}

function mapping(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function schedule(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function connection(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    status: row.status,
    credentialStatus: row.credential_status,
    updatedAt: row.updated_at,
    ...(row.database_id ? { databaseId: row.database_id, propertyMapping: mapping(row.property_mapping_json) } : {}),
    ...(row.data_source_id !== undefined ? { dataSourceId: row.data_source_id } : {}),
    ...(row.workspace_ref !== undefined ? { workspaceRef: row.workspace_ref } : {}),
    ...(row.provider_account_ref !== undefined ? { providerAccountRef: row.provider_account_ref } : {}),
  };
}

function profile(row: {
  id: string;
  name: string;
  notion_connection_id: string;
  thousand_school_account_id: string;
  default_mode: string;
  schedule_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}): AutomationProfile {
  return {
    id: row.id,
    name: row.name,
    notionConnectionId: row.notion_connection_id,
    thousandSchoolAccountId: row.thousand_school_account_id,
    defaultMode: row.default_mode,
    schedule: schedule(row.schedule_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionRepository {
  constructor(private readonly db: D1Database) {}

  async getNotion(userId: string): Promise<ConnectionView | null> {
    const row = await this.db
      .prepare(
        `SELECT n.id, n.workspace_ref, n.database_id, n.data_source_id, n.property_mapping_json, n.status,
                n.updated_at, c.status AS credential_status
         FROM notion_connections n
         JOIN credentials c ON c.id = n.credential_id AND c.user_id = n.user_id
         WHERE n.user_id = ? AND n.status != 'DISABLED' LIMIT 1`,
      )
      .bind(userId)
      .first<ConnectionRow>();
    return row ? connection(row) : null;
  }

  async getNotionRuntime(userId: string, profileId: string, masterKey: string): Promise<NotionRuntime> {
    const row = await this.db
      .prepare(
        `SELECT n.data_source_id, n.property_mapping_json, c.key_version, c.iv, c.encrypted_payload
         FROM automation_profiles p
         JOIN notion_connections n ON n.id = p.notion_connection_id AND n.user_id = p.user_id
         JOIN thousand_school_accounts a ON a.id = p.thousand_school_account_id AND a.user_id = p.user_id
         JOIN credentials c ON c.id = n.credential_id AND c.user_id = n.user_id
         JOIN credentials ac ON ac.id = a.credential_id AND ac.user_id = a.user_id
         WHERE p.user_id = ? AND p.id = ? AND p.enabled = 1
           AND n.status = 'ACTIVE' AND a.status = 'ACTIVE'
           AND c.status = 'ACTIVE' AND ac.status = 'ACTIVE'`,
      )
      .bind(userId, profileId)
      .first<{ data_source_id: string | null; property_mapping_json: string; key_version: number; iv: string; encrypted_payload: string }>();
    if (!row || !row.data_source_id) throw new HttpError(400, "PROFILE_REQUIRED", "An active Notion data source is required");
    const payload = await decryptCredential({ keyVersion: row.key_version, iv: row.iv, encryptedPayload: row.encrypted_payload }, masterKey);
    if (typeof payload.token !== "string" || !payload.token) throw new HttpError(500, "CREDENTIAL_INVALID", "Stored credential is invalid");
    return { dataSourceId: row.data_source_id, token: payload.token, propertyMapping: mapping(row.property_mapping_json) };
  }

  async markNotionAuthRequired(userId: string, profileId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE notion_connections SET status = 'AUTH_REQUIRED', updated_at = ?
         WHERE user_id = ? AND id = (SELECT notion_connection_id FROM automation_profiles WHERE user_id = ? AND id = ?)`,
      ).bind(now, userId, userId, profileId),
      this.db.prepare(
        `UPDATE credentials SET status = 'AUTH_REQUIRED', updated_at = ?
         WHERE user_id = ? AND id = (
           SELECT credential_id FROM notion_connections WHERE user_id = ? AND id =
             (SELECT notion_connection_id FROM automation_profiles WHERE user_id = ? AND id = ?)
         )`,
      ).bind(now, userId, userId, userId, profileId),
    ]);
  }

  async getThousandSchool(userId: string): Promise<ConnectionView | null> {
    const row = await this.db
      .prepare(
        `SELECT a.id, a.provider_account_ref, a.status, a.updated_at,
                c.status AS credential_status
         FROM thousand_school_accounts a
         JOIN credentials c ON c.id = a.credential_id AND c.user_id = a.user_id
         WHERE a.user_id = ? AND a.status != 'DISABLED' LIMIT 1`,
      )
      .bind(userId)
      .first<ConnectionRow>();
    return row ? connection(row) : null;
  }

  async upsertNotion(
    userId: string,
    input: { token: string; databaseId: string; dataSourceId: string; workspaceRef?: string; propertyMapping: Record<string, string> },
    masterKey: string,
    keyVersion: number,
  ): Promise<ConnectionView> {
    // ponytail: one active connection per provider; add collection endpoints when multi-account UI is needed.
    const existing = await this.db
      .prepare("SELECT id, credential_id FROM notion_connections WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; credential_id: string }>();
    const credentialId = crypto.randomUUID();
    const connectionId = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const encrypted = await encryptCredential({ token: input.token }, masterKey, keyVersion);
    const statements = [
      this.db
        .prepare(
          `INSERT INTO credentials
           (id, user_id, kind, key_version, iv, encrypted_payload, status, created_at, updated_at)
           VALUES (?, ?, 'NOTION', ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(credentialId, userId, encrypted.keyVersion, encrypted.iv, encrypted.encryptedPayload, now, now),
      existing
        ? this.db
            .prepare(
              `UPDATE notion_connections
               SET credential_id = ?, workspace_ref = ?, database_id = ?, data_source_id = ?, property_mapping_json = ?,
                   status = 'ACTIVE', updated_at = ?
               WHERE user_id = ? AND id = ?`,
            )
            .bind(
              credentialId,
              input.workspaceRef ?? null,
              input.databaseId,
              input.dataSourceId,
              JSON.stringify(input.propertyMapping),
              now,
              userId,
              connectionId,
            )
        : this.db
            .prepare(
              `INSERT INTO notion_connections
               (id, user_id, credential_id, workspace_ref, database_id, data_source_id, property_mapping_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
            )
            .bind(
              connectionId,
              userId,
              credentialId,
              input.workspaceRef ?? null,
              input.databaseId,
              input.dataSourceId,
              JSON.stringify(input.propertyMapping),
              now,
              now,
            ),
    ];
    if (existing) {
      statements.push(
        this.db
          .prepare("UPDATE credentials SET status = 'REVOKED', updated_at = ? WHERE user_id = ? AND id = ?")
          .bind(now, userId, existing.credential_id),
      );
    }
    await this.db.batch(statements);
    const result = await this.getNotion(userId);
    if (!result) throw new Error("Notion connection could not be loaded");
    return result;
  }

  async upsertThousandSchool(
    userId: string,
    input: { token: string; providerAccountRef?: string; expiresAt?: string },
    masterKey: string,
    keyVersion: number,
  ): Promise<ConnectionView> {
    const existing = await this.db
      .prepare("SELECT id, credential_id FROM thousand_school_accounts WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; credential_id: string }>();
    const credentialId = crypto.randomUUID();
    const accountId = existing?.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const encrypted = await encryptCredential({ token: input.token }, masterKey, keyVersion);
    const statements = [
      this.db
        .prepare(
          `INSERT INTO credentials
           (id, user_id, kind, key_version, iv, encrypted_payload, status, expires_at, created_at, updated_at)
           VALUES (?, ?, 'THOUSAND_SCHOOL', ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .bind(credentialId, userId, encrypted.keyVersion, encrypted.iv, encrypted.encryptedPayload, input.expiresAt ?? null, now, now),
      existing
        ? this.db
            .prepare(
              `UPDATE thousand_school_accounts
               SET credential_id = ?, provider_account_ref = ?, status = 'ACTIVE', expires_at = ?, updated_at = ?
               WHERE user_id = ? AND id = ?`,
            )
            .bind(credentialId, input.providerAccountRef ?? null, input.expiresAt ?? null, now, userId, accountId)
        : this.db
            .prepare(
              `INSERT INTO thousand_school_accounts
               (id, user_id, credential_id, provider_account_ref, status, expires_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
            )
            .bind(accountId, userId, credentialId, input.providerAccountRef ?? null, input.expiresAt ?? null, now, now),
    ];
    if (existing) {
      statements.push(
        this.db
          .prepare("UPDATE credentials SET status = 'REVOKED', updated_at = ? WHERE user_id = ? AND id = ?")
          .bind(now, userId, existing.credential_id),
      );
    }
    await this.db.batch(statements);
    const result = await this.getThousandSchool(userId);
    if (!result) throw new Error("1000.school connection could not be loaded");
    return result;
  }

  async disableNotion(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id, credential_id FROM notion_connections WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; credential_id: string }>();
    if (!row) return false;
    return this.disableConnection(userId, "notion_connections", row.id, row.credential_id);
  }

  async disableThousandSchool(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id, credential_id FROM thousand_school_accounts WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; credential_id: string }>();
    if (!row) return false;
    return this.disableConnection(userId, "thousand_school_accounts", row.id, row.credential_id);
  }

  private async disableConnection(userId: string, table: "notion_connections" | "thousand_school_accounts", id: string, credentialId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const profiles = table === "notion_connections"
      ? "notion_connection_id"
      : "thousand_school_account_id";
    const result = await this.db.batch([
      this.db.prepare(`UPDATE ${table} SET status = 'DISABLED', updated_at = ? WHERE user_id = ? AND id = ?`).bind(now, userId, id),
      this.db.prepare("UPDATE credentials SET status = 'REVOKED', updated_at = ? WHERE user_id = ? AND id = ?").bind(now, userId, credentialId),
      this.db.prepare(`UPDATE automation_profiles SET enabled = 0, updated_at = ? WHERE user_id = ? AND ${profiles} = ?`).bind(now, userId, id),
      this.db.prepare(
        `UPDATE jobs SET status = 'CANCELLED', updated_at = ?
         WHERE user_id = ? AND profile_id IN
           (SELECT id FROM automation_profiles WHERE user_id = ? AND ${profiles} = ?)
           AND status NOT IN ('SAVED', 'FAILED_FINAL', 'CANCELLED')`,
      ).bind(now, userId, userId, id),
    ]);
    return result.length > 0;
  }

  async listProfiles(userId: string): Promise<AutomationProfile[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, notion_connection_id, thousand_school_account_id, default_mode,
                schedule_json, enabled, created_at, updated_at
         FROM automation_profiles WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .bind(userId)
      .all();
    return results.map((row) => profile(row as Parameters<typeof profile>[0]));
  }

  async getProfile(userId: string, profileId: string): Promise<AutomationProfile | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name, notion_connection_id, thousand_school_account_id, default_mode,
                schedule_json, enabled, created_at, updated_at
         FROM automation_profiles WHERE user_id = ? AND id = ?`,
      )
      .bind(userId, profileId)
      .first<Parameters<typeof profile>[0]>();
    return row ? profile(row) : null;
  }

  async createProfile(
    userId: string,
    input: { name: string; notionConnectionId: string; thousandSchoolAccountId: string; defaultMode: string; schedule: Record<string, unknown> | null },
  ): Promise<AutomationProfile> {
    await this.assertActiveLinks(userId, input.notionConnectionId, input.thousandSchoolAccountId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO automation_profiles
         (id, user_id, name, notion_connection_id, thousand_school_account_id, default_mode, schedule_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(id, userId, input.name, input.notionConnectionId, input.thousandSchoolAccountId, input.defaultMode, input.schedule ? JSON.stringify(input.schedule) : null, now, now)
      .run();
    const result = await this.getProfile(userId, id);
    if (!result) throw new Error("Automation profile could not be loaded");
    return result;
  }

  async updateProfile(
    userId: string,
    profileId: string,
    input: Partial<{ name: string; notionConnectionId: string; thousandSchoolAccountId: string; defaultMode: string; schedule: Record<string, unknown> | null; enabled: boolean }>,
  ): Promise<AutomationProfile> {
    const current = await this.getProfile(userId, profileId);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Not found");
    const notionConnectionId = input.notionConnectionId ?? current.notionConnectionId;
    const thousandSchoolAccountId = input.thousandSchoolAccountId ?? current.thousandSchoolAccountId;
    await this.assertActiveLinks(userId, notionConnectionId, thousandSchoolAccountId);
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE automation_profiles
         SET name = ?, notion_connection_id = ?, thousand_school_account_id = ?, default_mode = ?,
             schedule_json = ?, enabled = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      )
      .bind(
        input.name ?? current.name,
        notionConnectionId,
        thousandSchoolAccountId,
        input.defaultMode ?? current.defaultMode,
        input.schedule === undefined ? (current.schedule ? JSON.stringify(current.schedule) : null) : input.schedule ? JSON.stringify(input.schedule) : null,
        input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        now,
        userId,
        profileId,
      )
      .run();
    const result = await this.getProfile(userId, profileId);
    if (!result) throw new Error("Automation profile could not be loaded");
    return result;
  }

  async disableProfile(userId: string, profileId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.batch([
      this.db.prepare("UPDATE automation_profiles SET enabled = 0, updated_at = ? WHERE user_id = ? AND id = ?").bind(now, userId, profileId),
      this.db.prepare(
        `UPDATE jobs SET status = 'CANCELLED', updated_at = ?
         WHERE user_id = ? AND profile_id = ? AND status NOT IN ('SAVED', 'FAILED_FINAL', 'CANCELLED')`,
      ).bind(now, userId, profileId),
    ]);
    return result[0]?.meta.changes === 1;
  }

  private async assertActiveLinks(userId: string, notionConnectionId: string, thousandSchoolAccountId: string): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT id FROM notion_connections WHERE id = ? AND user_id = ? AND status = 'ACTIVE') AS notion_id,
           (SELECT id FROM thousand_school_accounts WHERE id = ? AND user_id = ? AND status = 'ACTIVE') AS account_id`,
      )
      .bind(notionConnectionId, userId, thousandSchoolAccountId, userId)
      .first<{ notion_id: string | null; account_id: string | null }>();
    if (!row?.notion_id || !row.account_id) throw new HttpError(400, "INVALID_PROFILE", "Connections must belong to the current user");
  }
}
