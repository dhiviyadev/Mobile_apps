-- Real orders sent to a broker through NEXUS (a local record; the broker's order book is the source of truth).
CREATE TABLE broker_orders (
  id TEXT PRIMARY KEY,
  broker TEXT NOT NULL,
  broker_order_id TEXT,
  exchange TEXT NOT NULL,
  tradingsymbol TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  product TEXT NOT NULL,
  order_type TEXT NOT NULL,
  variety TEXT NOT NULL,
  price REAL,
  trigger_price REAL,
  estimated_value REAL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_broker_orders_created ON broker_orders(created_at DESC);
