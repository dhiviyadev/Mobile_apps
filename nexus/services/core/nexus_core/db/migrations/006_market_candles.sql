-- Daily price bars kept locally (as received from the official source) so history is downloaded once and topped up.
CREATE TABLE market_candles (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  v REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, date)
) WITHOUT ROWID;

CREATE TABLE market_series (
  symbol TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  synced_at REAL NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  actions TEXT NOT NULL DEFAULT '[]',
  actions_at REAL NOT NULL DEFAULT 0
);
