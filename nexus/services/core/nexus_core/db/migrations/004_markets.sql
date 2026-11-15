-- Markets: watchlist, price alerts and a practice (paper) trading account. No real money is ever involved.
CREATE TABLE market_watchlist (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  exchange TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);

CREATE TABLE market_alerts (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  price REAL NOT NULL,
  created_at TEXT NOT NULL,
  triggered_at TEXT,
  triggered_price REAL
);

CREATE TABLE paper_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  currency TEXT NOT NULL,
  starting_cash REAL NOT NULL,
  cash REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_positions (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  avg_cost REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE paper_orders (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  total REAL NOT NULL,
  realized_pnl REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_paper_orders_created ON paper_orders(created_at DESC);
