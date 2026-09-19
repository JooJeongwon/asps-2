import type { User } from "../types/domain";

interface UserRow {
  id: string;
  auth_subject: string;
  email: string | null;
  display_name: string | null;
  status: "ACTIVE" | "DISABLED";
  created_at: string;
  updated_at: string;
}

function user(row: UserRow): User {
  return {
    id: row.id,
    authSubject: row.auth_subject,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare(
        `SELECT id, auth_subject, email, display_name, status, created_at, updated_at
         FROM users WHERE id = ?`,
      )
      .bind(id)
      .first<UserRow>();
    return row ? user(row) : null;
  }

  async upsertByAuthSubject(input: {
    subject: string;
    email: string | null;
    displayName: string | null;
  }): Promise<User> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO users (id, auth_subject, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (auth_subject) DO UPDATE SET
           email = COALESCE(excluded.email, users.email),
           display_name = COALESCE(excluded.display_name, users.display_name),
           updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), input.subject, input.email, input.displayName, now, now)
      .run();

    const row = await this.db
      .prepare(
        `SELECT id, auth_subject, email, display_name, status, created_at, updated_at
         FROM users WHERE auth_subject = ?`,
      )
      .bind(input.subject)
      .first<UserRow>();

    if (!row) throw new Error("Authenticated user could not be loaded");
    return user(row);
  }
}
