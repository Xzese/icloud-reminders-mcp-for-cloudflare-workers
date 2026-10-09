-- Current schema for a new iCloud Reminders deployment.
-- Reapplying this file preserves existing tables and session data.
CREATE TABLE IF NOT EXISTS apple_session_state (
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'DISCONNECTED',
  action TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  envelope TEXT,
  transaction_id TEXT,
  transaction_expires_at INTEGER,
  resume_id TEXT,
  resume_expires_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, account_id)
);
