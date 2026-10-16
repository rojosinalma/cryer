CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages (id),
  channel_id TEXT NOT NULL,
  discord_message_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  options_json TEXT NOT NULL,
  modal_json TEXT,
  ttl_s INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  callback_json TEXT,
  session_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS prompts_status_expires ON prompts (status, expires_at);
CREATE INDEX IF NOT EXISTS prompts_created_at ON prompts (created_at);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts (id),
  choice_idx INTEGER NOT NULL,
  choice_id TEXT NOT NULL,
  text TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS answers_prompt_id ON answers (prompt_id);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
