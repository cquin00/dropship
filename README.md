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

Import CSV takes a header row. `upc` (or `gtin`) and `cost` are required. Optional columns: `source`, `shipping`, `fees`, `quantity`, `moq`, `condition`, `confidence`.

- Rows are matched to tracked products by UPC/GTIN, ignoring leading zeros.
- Amounts like `$1,250.00` are accepted. Rows with an unreadable number are skipped and counted.
- Supplier names are matched case-insensitively. Unknown names are filed under Custom Manifest.
- A blank `confidence` means 100, because the row was matched on an exact UPC.
- Products and supplier offers are stored in D1. An offer is a `vendor_inventory` row (supplier, cost, quantity, MOQ, condition) linked to a product by a `matches` row (match method and confidence). Importing a CSV again for the same product and supplier replaces the earlier offer. Only the supplier on/off switches are kept in the browser.

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
