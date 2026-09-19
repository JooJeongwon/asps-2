export interface Env {
  DB: D1Database;
  JOB_QUEUE: Queue;
  CREDENTIAL_ENCRYPTION_KEY: string;
  CREDENTIAL_KEY_VERSION?: string;
  SESSION_SECRET: string;
  WEBHOOK_SIGNING_SECRET: string;
  OAUTH_ISSUER: string;
  OAUTH_AUTHORIZATION_URL: string;
  OAUTH_TOKEN_URL: string;
  OAUTH_USERINFO_URL: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI: string;
}
