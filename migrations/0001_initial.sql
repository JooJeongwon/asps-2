PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTION', 'THOUSAND_SCHOOL')),
  key_version INTEGER NOT NULL,
  iv TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'AUTH_REQUIRED', 'REVOKED')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE notion_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  workspace_ref TEXT,
  database_id TEXT NOT NULL,
  property_mapping_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'AUTH_REQUIRED', 'DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (credential_id, user_id)
    REFERENCES credentials (id, user_id)
);

CREATE TABLE thousand_school_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  provider_account_ref TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'AUTH_REQUIRED', 'DISABLED')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (credential_id, user_id)
    REFERENCES credentials (id, user_id)
);

CREATE TABLE automation_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notion_connection_id TEXT NOT NULL,
  thousand_school_account_id TEXT NOT NULL,
  default_mode TEXT NOT NULL DEFAULT 'FULL_AUTO'
    CHECK (default_mode IN ('DRAFT_ONLY', 'SUGGEST', 'SCORE', 'SAVE', 'FULL_AUTO')),
  schedule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (notion_connection_id, user_id)
    REFERENCES notion_connections (id, user_id),
  FOREIGN KEY (thousand_school_account_id, user_id)
    REFERENCES thousand_school_accounts (id, user_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  notion_page_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  mode TEXT NOT NULL
    CHECK (mode IN ('DRAFT_ONLY', 'SUGGEST', 'SCORE', 'SAVE', 'FULL_AUTO')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING', 'FETCHED', 'DRAFT_CREATED', 'AI_SUGGESTED', 'AI_SCORED',
      'SAVED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'AUTH_REQUIRED',
      'PROFILE_REQUIRED', 'CANCELLED'
    )),
  content_hash TEXT NOT NULL,
  remote_record_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, profile_id, notion_page_id, target_date, content_hash, mode),
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (profile_id, user_id)
    REFERENCES automation_profiles (id, user_id)
);

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('FETCH', 'CREATE_DRAFT', 'AI_SUGGEST', 'AI_SCORE', 'SAVE', 'NOTION_UPDATE')),
  status TEXT NOT NULL
    CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  output_ref TEXT,
  safe_error_code TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (user_id, job_id, stage),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (job_id, user_id)
    REFERENCES jobs (id, user_id)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (actor_user_id) REFERENCES users (id)
);

CREATE INDEX idx_credentials_user ON credentials (user_id, status);
CREATE INDEX idx_notion_connections_user ON notion_connections (user_id, status);
CREATE INDEX idx_thousand_school_accounts_user ON thousand_school_accounts (user_id, status);
CREATE INDEX idx_automation_profiles_user ON automation_profiles (user_id, enabled);
CREATE INDEX idx_jobs_user_status ON jobs (user_id, status, updated_at);
CREATE INDEX idx_job_steps_user_job ON job_steps (user_id, job_id, stage);
CREATE INDEX idx_audit_logs_user_created ON audit_logs (user_id, created_at);
