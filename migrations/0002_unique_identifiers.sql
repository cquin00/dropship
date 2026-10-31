-- One row per UPC and per GTIN. Rows without an identifier (NULL) are not
-- constrained, so MPN-only products are still allowed.
-- Before applying to production, check for existing duplicates (see README);
-- this migration fails if any are present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_walmart_products_upc
  ON walmart_products (upc)
  WHERE upc IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_walmart_products_gtin
  ON walmart_products (gtin)
  WHERE gtin IS NOT NULL;

-- The unique indexes above also serve lookups, so the older plain indexes
-- on the same columns are redundant.
DROP INDEX IF EXISTS idx_walmart_upc;
DROP INDEX IF EXISTS idx_walmart_gtin;
