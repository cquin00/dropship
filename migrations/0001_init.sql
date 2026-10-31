-- Baseline schema, taken from the production export
-- (npx wrangler d1 export sourcematch-db --remote --no-data) on 2026-10-31.
-- IF NOT EXISTS makes this a no-op on the existing production database.
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  connector_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  connector_status TEXT NOT NULL DEFAULT 'not_configured',
  inventory_url TEXT,
  last_sync_started TEXT,
  last_sync_completed TEXT,
  last_sync_status TEXT,
  last_sync_message TEXT,
  next_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS vendor_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL,
  vendor_sku TEXT,
  upc TEXT,
  gtin TEXT,
  mpn TEXT,
  title TEXT NOT NULL,
  brand TEXT,
  pack_count TEXT,
  condition TEXT,
  unit_cost REAL,
  shipping_cost REAL,
  available_quantity INTEGER,
  moq INTEGER,
  product_url TEXT,
  source_updated_at TEXT,
  imported_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE TABLE IF NOT EXISTS walmart_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  upc TEXT,
  gtin TEXT,
  mpn TEXT,
  walmart_price REAL,
  walmart_url TEXT,
  bestseller_rank INTEGER,
  review_count INTEGER,
  oos_status TEXT,
  detected_at TEXT,
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walmart_product_id INTEGER NOT NULL,
  inventory_item_id INTEGER NOT NULL,
  match_method TEXT NOT NULL,
  match_confidence REAL NOT NULL,
  landed_cost REAL,
  estimated_profit REAL,
  estimated_margin REAL,
  opportunity_score REAL,
  recommendation TEXT,
  calculated_at TEXT NOT NULL,
  FOREIGN KEY (walmart_product_id) REFERENCES walmart_products(id),
  FOREIGN KEY (inventory_item_id) REFERENCES vendor_inventory(id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  rows_received INTEGER DEFAULT 0,
  rows_imported INTEGER DEFAULT 0,
  rows_rejected INTEGER DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_vendor ON vendor_inventory(vendor_id);
CREATE INDEX IF NOT EXISTS idx_inventory_upc ON vendor_inventory(upc);
CREATE INDEX IF NOT EXISTS idx_inventory_gtin ON vendor_inventory(gtin);
CREATE INDEX IF NOT EXISTS idx_inventory_mpn ON vendor_inventory(mpn);
CREATE INDEX IF NOT EXISTS idx_walmart_upc ON walmart_products(upc);
CREATE INDEX IF NOT EXISTS idx_walmart_gtin ON walmart_products(gtin);
CREATE INDEX IF NOT EXISTS idx_walmart_mpn ON walmart_products(mpn);
CREATE INDEX IF NOT EXISTS idx_matches_walmart ON matches(walmart_product_id);
CREATE INDEX IF NOT EXISTS idx_matches_inventory ON matches(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_sync_vendor ON sync_runs(vendor_id);
