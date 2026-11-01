# SourceMatch Cloudflare

Cloudflare Worker + static-assets prototype.

## GitHub / Cloudflare deployment

Cloudflare build command: leave blank
Cloudflare deploy command: `npx wrangler deploy`
Root directory: `/`

The first deployed version includes a working Worker API, dashboard, supplier controls, landed-cost calculation, and green/yellow/red ranking.

Live Walmart and supplier searches require authorized APIs, feeds, or imported manifests.

## Database (D1)

The schema lives in `migrations/`. Wrangler records which migrations have run in a `d1_migrations` table.

```sh
# See what would run
npx wrangler d1 migrations list sourcematch-db --remote

# Apply (run the duplicate check below first)
npx wrangler d1 migrations apply sourcematch-db --remote
```

Apply the migrations before you deploy code that depends on them. Use `--local` instead of `--remote` to try them with `wrangler dev` first.

### Before applying `0002_unique_identifiers.sql`

That migration adds one-row-per-UPC and one-row-per-GTIN indexes. It fails if duplicates already exist. Check first:

```sh
npx wrangler d1 execute sourcematch-db --remote --command "SELECT 'upc' AS field, upc AS value, COUNT(*) AS copies, GROUP_CONCAT(id) AS ids FROM walmart_products WHERE upc IS NOT NULL GROUP BY upc HAVING COUNT(*) > 1 UNION ALL SELECT 'gtin', gtin, COUNT(*), GROUP_CONCAT(id) FROM walmart_products WHERE gtin IS NOT NULL GROUP BY gtin HAVING COUNT(*) > 1"
```

If any rows come back, decide which `id` to keep for each value and delete the others before applying.

## Supplier offer CSV

Import CSV works out the file type from its header row (the dashboard's **CSV formats** link has templates):

- **Walmart products**: `title`, `price` (or `walmart_price`), and a `upc`, `gtin`, or `mpn` are required. Optional: `oos_status`, `rank`, `reviews`, `walmart_url`. Common header variants such as "Product Name" or "Walmart Price" are accepted, and free-text signals like "shipping oos" or "low stock" are mapped onto the three OOS signals. Products already tracked by UPC/GTIN get their price and status refreshed. Rows are sent to `POST /api/products/import` in batches of 100; rejected rows are reported with their CSV line number.
- **Supplier offers**: any file with a `cost` column. `upc` (or `gtin`) and `cost` are required. Optional columns: `source`, `shipping`, `fees`, `quantity`, `moq`, `condition`, `confidence`.
- **Supplier manifests with their own column names** (e.g. "Item UPC", "Unit Cost", "Qty"): a Match columns dialog guesses each column and the supplier (from the file name), shows a preview, and can remember the layout for that supplier. Saved layouts live in `vendors.column_mapping` (`GET/PUT/DELETE /api/layouts`); a later file whose columns match a saved layout imports in one step. Forget a layout from the Supplier Control Center.

For offers:

- Rows are matched to tracked products by UPC/GTIN, ignoring leading zeros.
- Amounts like `$1,250.00` are accepted. Rows with an unreadable number are skipped and counted.
- Supplier names are matched case-insensitively. Unknown names are filed under Custom Manifest.
- A blank `confidence` means 100, because the row was matched on an exact UPC.
- Products and supplier offers are stored in D1. An offer is a `vendor_inventory` row (supplier, cost, quantity, MOQ, condition) linked to a product by a `matches` row (match method and confidence). Importing a CSV again for the same product and supplier replaces the earlier offer. Only the supplier on/off switches are kept in the browser.

## Price and stock history

Migration `0005_history.sql` adds `product_history` (Walmart price and OOS signal) and `inventory_history` (supplier cost, shipping, fees, quantity). Database triggers record a row whenever one of those values actually changes, on any write path; unchanged re-imports add nothing. Existing rows were backfilled as the starting point. `GET /api/history?product_id=` returns both, and the dashboard shows them in each offer's Details: a step chart of the Walmart price, a change table, and that supplier's cost history. "Clear all offers" also removes offer cost history; product history is kept.

## Walmart stock checks (SerpApi)

A daily Cron Trigger (13:00 UTC, set in `wrangler.jsonc`) checks the products that were checked least recently, `STOCK_CHECKS_PER_RUN` at a time (default 8, max 20), through [SerpApi's Walmart Product API](https://serpapi.com/walmart-product-api). Each check updates the product's Walmart price and signal: `In stock`, `Shipping OOS` (in stock but not shippable) or `Fulfillment/DC OOS` (not in stock). Changes land in price history, which gives "days out of stock" once an item has been seen in stock.

- A product with a `walmart.com/ip/...` URL costs one SerpApi search per check. A product with only a UPC/GTIN is found by a UPC search first (a second search), accepted only when Walmart's UPC agrees, and its Walmart URL is saved so later checks cost one.
- Products back in stock show as **Pass** in the queue ("Walmart has this back in stock").
- Each offer's Details has **Check now** for one product. `GET /api/stock-checks` returns the setup state and last run; `POST /api/stock-checks {"product_id": N}` checks one product.
- Migration `0006_stock_checks.sql` adds `stock_checked_at`, `stock_check_error` and the `stock_check_runs` log.

Setup: `npx wrangler secret put SERPAPI_KEY` (paste the key from serpapi.com/manage-api-key). Without it, checks are skipped and the dashboard says they aren't set up. Size `STOCK_CHECKS_PER_RUN` to your SerpApi plan: roughly 30 x the per-run number searches a month, plus one extra search the first time each product without a Walmart URL is checked.

## Restricting access with Cloudflare Access

The dashboard and API have no login of their own. Put Cloudflare Access in front of the whole Worker so only you can reach it:

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, pick a team name and the **Free** plan.
2. Go to **Access → Applications → Add an application → Self-hosted**.
3. Name it `SourceMatch`. Under **Public hostname** (or **Application domain**), enter the Worker's workers.dev hostname, e.g. `dropship.<your-subdomain>.workers.dev`. You can find it in **Workers & Pages → dropship → Settings → Domains & Routes**. Leave the path empty so the dashboard and every `/api/*` route are covered.
4. Add a policy: name `Only me`, action **Allow**, rule **Include → Emails →** your email address.
5. Under **Authentication**, keep **One-time PIN** enabled (it is on by default), or pick another identity provider you use.
6. Save the application.
7. In **Workers & Pages → dropship → Settings → Domains & Routes**, turn off **Preview URLs** unless you also protect them. They use a different hostname and would bypass the policy.
8. Test in a private browser window. You should see the Access login page. Enter your email, then the code you receive, and the dashboard loads.

If you later add a custom domain, add that hostname to the same Access application.
