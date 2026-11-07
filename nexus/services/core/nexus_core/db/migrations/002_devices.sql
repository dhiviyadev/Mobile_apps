-- Paired phones / remote devices. Tokens are stored only as SHA-256 hashes.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- One-time pairing codes (hashed), valid for a few minutes.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at REAL NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
