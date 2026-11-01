-- Price and stock history. Triggers record a row whenever a tracked value
-- actually changes, so every write path (single save, bulk import, offer
-- import, upserts) is covered without application code.

CREATE TABLE IF NOT EXISTS product_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walmart_product_id INTEGER NOT NULL,
  walmart_price REAL,
  oos_status TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (walmart_product_id) REFERENCES walmart_products(id)
);

CREATE INDEX IF NOT EXISTS idx_product_history_product
  ON product_history (walmart_product_id, id);

CREATE TABLE IF NOT EXISTS inventory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_item_id INTEGER NOT NULL,
  unit_cost REAL,
  shipping_cost REAL,
  fees REAL,
  available_quantity INTEGER,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (inventory_item_id) REFERENCES vendor_inventory(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_history_item
  ON inventory_history (inventory_item_id, id);

-- Starting point: the current values of everything already tracked.
INSERT INTO product_history (walmart_product_id, walmart_price, oos_status, recorded_at)
SELECT id, walmart_price, oos_status,
       COALESCE(last_checked_at, detected_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM walmart_products
WHERE id NOT IN (SELECT walmart_product_id FROM product_history);

INSERT INTO inventory_history (inventory_item_id, unit_cost, shipping_cost, fees, available_quantity, recorded_at)
SELECT id, unit_cost, shipping_cost, fees, available_quantity,
       COALESCE(imported_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM vendor_inventory
WHERE id NOT IN (SELECT inventory_item_id FROM inventory_history);

CREATE TRIGGER IF NOT EXISTS trg_product_history_insert
AFTER INSERT ON walmart_products
BEGIN
  INSERT INTO product_history (walmart_product_id, walmart_price, oos_status, recorded_at)
  VALUES (NEW.id, NEW.walmart_price, NEW.oos_status,
          COALESCE(NEW.last_checked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER IF NOT EXISTS trg_product_history_update
AFTER UPDATE OF walmart_price, oos_status ON walmart_products
WHEN OLD.walmart_price IS NOT NEW.walmart_price
  OR OLD.oos_status IS NOT NEW.oos_status
BEGIN
  INSERT INTO product_history (walmart_product_id, walmart_price, oos_status, recorded_at)
  VALUES (NEW.id, NEW.walmart_price, NEW.oos_status,
          COALESCE(NEW.last_checked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_history_insert
AFTER INSERT ON vendor_inventory
BEGIN
  INSERT INTO inventory_history (inventory_item_id, unit_cost, shipping_cost, fees, available_quantity, recorded_at)
  VALUES (NEW.id, NEW.unit_cost, NEW.shipping_cost, NEW.fees, NEW.available_quantity,
          COALESCE(NEW.imported_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_history_update
AFTER UPDATE OF unit_cost, shipping_cost, fees, available_quantity ON vendor_inventory
WHEN OLD.unit_cost IS NOT NEW.unit_cost
  OR OLD.shipping_cost IS NOT NEW.shipping_cost
  OR OLD.fees IS NOT NEW.fees
  OR OLD.available_quantity IS NOT NEW.available_quantity
BEGIN
  INSERT INTO inventory_history (inventory_item_id, unit_cost, shipping_cost, fees, available_quantity, recorded_at)
  VALUES (NEW.id, NEW.unit_cost, NEW.shipping_cost, NEW.fees, NEW.available_quantity,
          COALESCE(NEW.imported_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;
