export class AuditRepository {
  constructor(private readonly db: D1Database) {}

  async record(input: {
    userId: string;
    action: string;
    targetType: string;
    targetId?: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_logs
         (id, user_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.userId,
        input.userId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        new Date().toISOString(),
      )
      .run();
  }
}
