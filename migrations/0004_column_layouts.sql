-- A supplier's saved CSV column layout, as JSON:
-- {"upc": "item upc", "cost": "unit cost", ...} mapping offer fields
-- to the (lowercased) header names in that supplier's manifests.
ALTER TABLE vendors ADD COLUMN column_mapping TEXT;
