export interface Env {
  DB: D1Database;
  JOB_QUEUE: Queue;
  CREDENTIAL_ENCRYPTION_KEY: string;
  CREDENTIAL_KEY_VERSION?: string;
  SESSION_SECRET: string;
  WEBHOOK_SIGNING_SECRET: string;
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  AUTH_JWKS_URL: string;
}
