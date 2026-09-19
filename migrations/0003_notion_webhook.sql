ALTER TABLE notion_connections ADD COLUMN webhook_key_version INTEGER;
ALTER TABLE notion_connections ADD COLUMN webhook_iv TEXT;
ALTER TABLE notion_connections ADD COLUMN webhook_encrypted_token TEXT;
UPDATE automation_profiles SET default_mode = 'FULL_AUTO' WHERE default_mode = 'DRAFT_ONLY';
