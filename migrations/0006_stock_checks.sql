-- Automatic Walmart stock checks (SerpApi).
-- stock_checked_at is when the checker last looked at Walmart, separate from
-- last_checked_at, which every import and edit also sets.
ALTER TABLE walmart_products ADD COLUMN stock_checked_at TEXT;
ALTER TABLE walmart_products ADD COLUMN stock_check_error TEXT;

CREATE INDEX IF NOT EXISTS idx_walmart_stock_checked
  ON walmart_products (stock_checked_at);

-- One row per checker run (daily schedule or a "Check now" click).
CREATE TABLE IF NOT EXISTS stock_check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  checked INTEGER DEFAULT 0,
  changed INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  error_message TEXT
);
