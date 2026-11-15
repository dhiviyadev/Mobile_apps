-- Projects group conversations, folders (by name), memories and automations.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'silver',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE conversations ADD COLUMN project_id TEXT;
ALTER TABLE memories ADD COLUMN project_id TEXT;
ALTER TABLE automations ADD COLUMN project_id TEXT;

-- Web Push subscriptions of paired phones.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
