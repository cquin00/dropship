-- Store supplier offers in D1 instead of the browser.
-- An offer is a vendor_inventory row (what the supplier sells, at what cost)
-- plus a matches row linking it to a walmart_products row.

-- The supplier list the dashboard shows (same names as /api/sources).
INSERT OR IGNORE INTO vendors (name, connector_type) VALUES
  ('NexDeal', 'liquidation'),
  ('B-Stock', 'liquidation'),
  ('Liquidation.com', 'liquidation'),
  ('Direct Liquidation', 'liquidation'),
  ('Via Trading', 'liquidation'),
  ('Quicklotz', 'liquidation'),
  ('BULQ', 'liquidation'),
  ('888 Lots', 'liquidation'),
  ('BlueLots', 'liquidation'),
  ('Doba', 'dropship'),
  ('CJdropshipping', 'dropship'),
  ('Spocket', 'dropship'),
  ('Syncee', 'dropship'),
  ('Inventory Source', 'dropship'),
  ('Manufacturer Feed', 'feed'),
  ('Custom Manifest', 'manifest');

-- Per-unit fees (platform, handling) were part of every offer but had no column.
ALTER TABLE vendor_inventory ADD COLUMN fees REAL;

-- One inventory row per supplier and identifier, and one match per
-- product and inventory row, so re-importing a manifest updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_vendor_upc_unique
  ON vendor_inventory (vendor_id, upc)
  WHERE upc IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_pair_unique
  ON matches (walmart_product_id, inventory_item_id);
