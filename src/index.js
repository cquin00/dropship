const sources = [
  "NexDeal",
  "B-Stock",
  "Liquidation.com",
  "Direct Liquidation",
  "Via Trading",
  "Quicklotz",
  "BULQ",
  "888 Lots",
  "BlueLots",
  "Doba",
  "CJdropshipping",
  "Spocket",
  "Syncee",
  "Inventory Source",
  "Manufacturer Feed",
  "Custom Manifest"
];

const OOS_STATUSES = [
  "Fulfillment/DC OOS",
  "Shipping OOS",
  "Low stock risk",
  "In stock"
];

const PREFERRED_CONDITIONS = ["new", "overstock"];

// Offer fields a saved supplier column layout can map.
const LAYOUT_FIELDS = [
  "upc",
  "gtin",
  "cost",
  "shipping",
  "fees",
  "quantity",
  "moq",
  "condition",
  "confidence"
];

// Request limits.
const MAX_PRODUCT_BODY_BYTES = 8 * 1024;
const MAX_RANK_BODY_BYTES = 1024 * 1024;
const MAX_RANK_GROUPS = 1000;
const MAX_RANK_ROWS = 2000;
const MAX_TITLE_LENGTH = 200;
const MAX_MPN_LENGTH = 64;
const MAX_URL_LENGTH = 500;
const MAX_ROW_TEXT_LENGTH = 80;
const MAX_PRICE = 100000;
const MAX_COUNT = 1000000000;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const MAX_PRODUCT_IMPORT_BODY_BYTES = 512 * 1024;
const MAX_PRODUCTS_PER_IMPORT = 200;
const MAX_IMPORT_ERRORS = 25;
const MAX_OFFER_BODY_BYTES = 512 * 1024;
const MAX_OFFERS_PER_REQUEST = 500;
const DEFAULT_OFFER_PAGE_SIZE = 2000;
const MAX_OFFER_PAGE_SIZE = 5000;
const MAX_HISTORY_ROWS = 500;
// Walmart stock checks (SerpApi). One search per check, two the first time
// a product without a Walmart URL is looked up by UPC.
const SERPAPI_URL = "https://serpapi.com/search.json";
const DEFAULT_CHECKS_PER_RUN = 8;
const MAX_CHECKS_PER_RUN = 20;
const CHECK_CONCURRENCY = 4;
// D1 allows at most 100 bound parameters per statement.
const MAX_IN_PARAMS = 90;

// Ranking defaults and bounds.
const DEFAULT_MIN_MARGIN = 15;
const DEFAULT_MIN_CONFIDENCE = 90;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Check whether the Worker and D1 database are connected.
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      try {
        await env.DB.prepare(
          "SELECT 1 AS database_test"
        ).first();

        return sendJSON({
          ok: true,
          version: "2.2",
          database: "connected"
        });
      } catch (error) {
        console.error("Health check failed:", error);
        return sendJSON(
          {
            ok: false,
            version: "2.2",
            database: "not connected"
          },
          500
        );
      }
    }

    // Return the supplier list.
    if (url.pathname === "/api/sources") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return sendJSON({ sources });
    }

    // Saved CSV column layouts, one per supplier.
    if (url.pathname === "/api/layouts") {
      if (request.method === "GET") {
        try {
          const result = await env.DB.prepare(
            "SELECT name, column_mapping FROM vendors WHERE column_mapping IS NOT NULL"
          ).all();
          const layouts = {};

          for (const row of result.results || []) {
            try {
              layouts[row.name] = JSON.parse(row.column_mapping);
            } catch (error) {
              console.error("Bad column_mapping for " + row.name, error);
            }
          }

          return sendJSON({ ok: true, layouts });
        } catch (error) {
          return serverError("Loading layouts failed", error);
        }
      }

      if (request.method === "PUT" || request.method === "DELETE") {
        const parsed = await readJSON(request, MAX_PRODUCT_BODY_BYTES);

        if (parsed.error) {
          return parsed.error;
        }

        const source = cleanText(parsed.data.source);
        let mapping = null;

        if (request.method === "PUT") {
          mapping = validateLayout(parsed.data.mapping);

          if (typeof mapping === "string") {
            return sendJSON({ ok: false, error: mapping }, 400);
          }
        }

        try {
          const result = await env.DB.prepare(
            "UPDATE vendors SET column_mapping = ? WHERE name = ?"
          )
            .bind(mapping ? JSON.stringify(mapping) : null, source)
            .run();

          if (!result.meta?.changes) {
            return sendJSON(
              { ok: false, error: "Unknown supplier." },
              404
            );
          }

          return sendJSON({ ok: true, source, mapping });
        } catch (error) {
          return serverError("Saving layout failed", error);
        }
      }

      return methodNotAllowed("GET, PUT, DELETE");
    }

    // Retrieve Walmart OOS products from D1, newest first.
    // Keyset pagination: pass ?before=<id> from next_before.
    if (
      url.pathname === "/api/products" &&
      request.method === "GET"
    ) {
      try {
        const limit = clamp(
          cleanInteger(url.searchParams.get("limit")) ??
            DEFAULT_PAGE_SIZE,
          1,
          MAX_PAGE_SIZE
        );
        const before = cleanInteger(
          url.searchParams.get("before")
        );

        const result = await env.DB.prepare(`
          SELECT
            id,
            title,
            upc,
            gtin,
            mpn,
            walmart_price,
            walmart_url,
            bestseller_rank,
            review_count,
            oos_status,
            detected_at,
            last_checked_at,
            stock_checked_at,
            stock_check_error
          FROM walmart_products
          WHERE (?1 IS NULL OR id < ?1)
          ORDER BY id DESC
          LIMIT ?2
        `)
          .bind(before, limit)
          .all();

        const products = result.results || [];

        return sendJSON({
          ok: true,
          products,
          next_before:
            products.length === limit
              ? products[products.length - 1].id
              : null
        });
      } catch (error) {
        return serverError("Loading products failed", error);
      }
    }

    // Save a Walmart OOS product into D1.
    // If the UPC or GTIN is already tracked, refresh it instead.
    if (
      url.pathname === "/api/products" &&
      request.method === "POST"
    ) {
      const parsed = await readJSON(
        request,
        MAX_PRODUCT_BODY_BYTES
      );

      if (parsed.error) {
        return parsed.error;
      }

      try {
        const validated = validateProduct(parsed.data);

        if (validated.error) {
          return sendJSON(
            { ok: false, error: validated.error },
            400
          );
        }

        const product = validated.product;
        const now = new Date().toISOString();
        const saved = await saveProduct(env, product, now);
        const created = saved.created;

        return sendJSON(
          {
            ok: true,
            created,
            message: created
              ? "Product added."
              : "Already tracked — updated price and status.",
            product_id: saved.id
          },
          created ? 201 : 200
        );
      } catch (error) {
        return serverError("Saving product failed", error);
      }
    }

    if (url.pathname === "/api/products") {
      return methodNotAllowed("GET, POST");
    }

    // Rank supplier offers for one or more products.
    // Body: { min_margin, min_confidence, max_moq,
    //         groups: [{ id, sell, rows: [...] }] }
    if (url.pathname === "/api/rank") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST");
      }

      const parsed = await readJSON(
        request,
        MAX_RANK_BODY_BYTES
      );

      if (parsed.error) {
        return parsed.error;
      }

      try {
        const data = parsed.data;
        const groups = Array.isArray(data.groups)
          ? data.groups
          : null;

        if (!groups) {
          return sendJSON(
            { ok: false, error: "groups must be an array." },
            400
          );
        }

        if (groups.length > MAX_RANK_GROUPS) {
          return sendJSON(
            {
              ok: false,
              error: `Send at most ${MAX_RANK_GROUPS} products per request.`
            },
            413
          );
        }

        let totalRows = 0;

        for (const group of groups) {
          if (
            !group ||
            typeof group !== "object" ||
            !Array.isArray(group.rows)
          ) {
            return sendJSON(
              {
                ok: false,
                error: "Each group needs an id, sell price, and rows array."
              },
              400
            );
          }

          totalRows += group.rows.length;
        }

        if (totalRows > MAX_RANK_ROWS) {
          return sendJSON(
            {
              ok: false,
              error: `Send at most ${MAX_RANK_ROWS} offers per request.`
            },
            413
          );
        }

        const settings = {
          minMargin: clamp(
            cleanNumber(data.min_margin) ??
              DEFAULT_MIN_MARGIN,
            0,
            90
          ),
          minConfidence: clamp(
            cleanNumber(data.min_confidence) ??
              DEFAULT_MIN_CONFIDENCE,
            0,
            100
          ),
          maxMoq: cleanInteger(data.max_moq)
        };

        if (settings.maxMoq !== null && settings.maxMoq < 1) {
          settings.maxMoq = null;
        }

        const results = groups.map((group) => ({
          id: cleanGroupId(group.id),
          rows: rankGroup(group, settings)
        }));

        return sendJSON({
          ok: true,
          settings: {
            min_margin: settings.minMargin,
            min_confidence: settings.minConfidence,
            max_moq: settings.maxMoq
          },
          results
        });
      } catch (error) {
        return serverError("Ranking failed", error);
      }
    }

    // Bulk-save products from a CSV import. Same rules as a single
    // save: already-tracked UPCs/GTINs get their price and status refreshed.
    if (url.pathname === "/api/products/import") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST");
      }

      const parsed = await readJSON(
        request,
        MAX_PRODUCT_IMPORT_BODY_BYTES
      );

      if (parsed.error) {
        return parsed.error;
      }

      try {
        return await importProducts(env, parsed.data);
      } catch (error) {
        return serverError("Importing products failed", error);
      }
    }

    // Price and stock history for one product and its supplier offers.
    if (url.pathname === "/api/history") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      const productId = cleanInteger(url.searchParams.get("product_id"));

      if (productId === null || productId < 1) {
        return sendJSON(
          { ok: false, error: "Pass a product_id." },
          400
        );
      }

      try {
        return await productHistory(env, productId);
      } catch (error) {
        return serverError("Loading history failed", error);
      }
    }

    // Walmart stock checks: status (GET) and "Check now" for one product (POST).
    if (url.pathname === "/api/stock-checks") {
      if (request.method === "GET") {
        try {
          const lastRun = await env.DB.prepare(
            "SELECT * FROM stock_check_runs ORDER BY id DESC LIMIT 1"
          ).first();

          return sendJSON({
            ok: true,
            configured: Boolean(env.SERPAPI_KEY),
            per_run: checksPerRun(env),
            last_run: lastRun
          });
        } catch (error) {
          return serverError("Loading stock check status failed", error);
        }
      }

      if (request.method === "POST") {
        const parsed = await readJSON(request, MAX_PRODUCT_BODY_BYTES);

        if (parsed.error) {
          return parsed.error;
        }

        const productId = cleanInteger(parsed.data.product_id);

        if (productId === null || productId < 1) {
          return sendJSON({ ok: false, error: "Pass a product_id." }, 400);
        }

        if (!env.SERPAPI_KEY) {
          return sendJSON(
            { ok: false, error: "Stock checks aren't set up yet: the SerpApi key is missing." },
            503
          );
        }

        try {
          const run = await runStockChecks(env, "manual", productId);

          if (!run.results.length) {
            return sendJSON({ ok: false, error: "Product not found." }, 404);
          }

          return sendJSON({ ok: true, ...run.results[0] });
        } catch (error) {
          return serverError("Stock check failed", error);
        }
      }

      return methodNotAllowed("GET, POST");
    }

    // Supplier offers: vendor_inventory rows matched to products.
    if (url.pathname === "/api/offers") {
      if (request.method === "GET") {
        try {
          return sendJSON(await listOffers(env, url));
        } catch (error) {
          return serverError("Loading offers failed", error);
        }
      }

      if (request.method === "POST") {
        const body = await readJSON(
          request,
          MAX_OFFER_BODY_BYTES
        );

        if (body.error) {
          return body.error;
        }

        try {
          return await importOffers(env, body.data);
        } catch (error) {
          return serverError("Saving offers failed", error);
        }
      }

      // Clears every offer. The dashboard asks for confirmation first.
      if (request.method === "DELETE") {
        try {
          // History rows reference inventory rows, so they go first.
          const [matches, , inventory] = await env.DB.batch([
            env.DB.prepare("DELETE FROM matches"),
            env.DB.prepare("DELETE FROM inventory_history"),
            env.DB.prepare("DELETE FROM vendor_inventory")
          ]);

          return sendJSON({
            ok: true,
            deleted: inventory.meta?.changes ?? null,
            matches_deleted: matches.meta?.changes ?? null
          });
        } catch (error) {
          return serverError("Clearing offers failed", error);
        }
      }

      return methodNotAllowed("GET, POST, DELETE");
    }

    // Any other /api/* path is not an endpoint.
    if (url.pathname.startsWith("/api/")) {
      return sendJSON(
        { ok: false, error: "Not found." },
        404
      );
    }

    // Serve the SourceMatch dashboard.
    return env.ASSETS.fetch(request);
  },

  // Daily Cron Trigger (wrangler.jsonc): check the products Walmart was
  // checked on longest ago.
  async scheduled(controller, env, ctx) {
    if (!env.SERPAPI_KEY) {
      console.log("Stock checks skipped: SERPAPI_KEY is not set.");
      return;
    }

    ctx.waitUntil(
      runStockChecks(env, "schedule").catch((error) =>
        console.error("Scheduled stock checks failed:", error)
      )
    );
  }
};

async function readJSON(request, maxBytes) {
  const contentType =
    request.headers.get("content-type") || "";

  if (
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    return {
      error: sendJSON(
        {
          ok: false,
          error: "Content-Type must be application/json."
        },
        415
      )
    };
  }

  const declaredLength = Number(
    request.headers.get("content-length")
  );

  if (declaredLength > maxBytes) {
    return { error: tooLarge(maxBytes) };
  }

  let text;

  try {
    text = await request.text();
  } catch (error) {
    return {
      error: sendJSON(
        { ok: false, error: "Could not read request body." },
        400
      )
    };
  }

  if (new TextEncoder().encode(text).length > maxBytes) {
    return { error: tooLarge(maxBytes) };
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    data = undefined;
  }

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return {
      error: sendJSON(
        {
          ok: false,
          error: "Request body must be a JSON object."
        },
        400
      )
    };
  }

  return { data };
}

function validateProduct(product) {
  const title = cleanText(product.title);
  const mpn = cleanText(product.mpn);
  const walmartUrl = cleanText(product.walmart_url);
  const walmartPrice = cleanNumber(product.walmart_price);
  const oosStatus =
    cleanText(product.oos_status) || OOS_STATUSES[0];

  if (!title) {
    return { error: "Product title is required." };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return {
      error: `Product title must be ${MAX_TITLE_LENGTH} characters or fewer.`
    };
  }

  const upc = normalizeIdentifier(product.upc);
  const gtin = normalizeIdentifier(product.gtin);

  if (upc === false || gtin === false) {
    return {
      error: "UPC/GTIN must be 8 to 14 digits."
    };
  }

  if (mpn.length > MAX_MPN_LENGTH) {
    return {
      error: `MPN must be ${MAX_MPN_LENGTH} characters or fewer.`
    };
  }

  if (mpn && !/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(mpn)) {
    return {
      error: "MPN may only contain letters, numbers, spaces, and . _ / -"
    };
  }

  if (!upc && !gtin && !mpn) {
    return { error: "UPC, GTIN, or MPN is required." };
  }

  if (
    walmartPrice === null ||
    walmartPrice <= 0 ||
    walmartPrice > MAX_PRICE
  ) {
    return { error: "A valid Walmart price is required." };
  }

  if (walmartUrl && !isWalmartUrl(walmartUrl)) {
    return {
      error: "Walmart URL must be an https://walmart.com link."
    };
  }

  if (!OOS_STATUSES.includes(oosStatus)) {
    return {
      error: "OOS status must be one of: " +
        OOS_STATUSES.join(", ") + "."
    };
  }

  const bestsellerRank = cleanCount(product.bestseller_rank);
  const reviewCount = cleanCount(product.review_count);

  if (bestsellerRank === false) {
    return {
      error: "Bestseller rank must be a whole number of 0 or more."
    };
  }

  if (reviewCount === false) {
    return {
      error: "Review count must be a whole number of 0 or more."
    };
  }

  return {
    product: {
      title,
      upc: upc || null,
      gtin: gtin || null,
      mpn: mpn || null,
      walmartPrice: Number(walmartPrice.toFixed(2)),
      walmartUrl: walmartUrl || null,
      bestsellerRank,
      reviewCount,
      oosStatus
    }
  };
}

const INSERT_PRODUCT_SQL = `
  INSERT INTO walmart_products (
    title,
    upc,
    gtin,
    mpn,
    walmart_price,
    walmart_url,
    bestseller_rank,
    review_count,
    oos_status,
    detected_at,
    last_checked_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_UPDATE_SQL = `
  DO UPDATE SET
    walmart_price = excluded.walmart_price,
    oos_status = excluded.oos_status,
    last_checked_at = excluded.last_checked_at
`;

async function saveProduct(env, product, now) {
  const values = [
    product.title,
    product.upc,
    product.gtin,
    product.mpn,
    product.walmartPrice,
    product.walmartUrl,
    product.bestsellerRank,
    product.reviewCount,
    product.oosStatus,
    now,
    now
  ];

  const existing = await env.DB.prepare(`
    SELECT id
    FROM walmart_products
    WHERE (?1 IS NOT NULL AND upc = ?1)
       OR (?2 IS NOT NULL AND gtin = ?2)
    ORDER BY id
    LIMIT 1
  `)
    .bind(product.upc, product.gtin)
    .first();

  try {
    // Requires the unique indexes from
    // migrations/0002_unique_identifiers.sql.
    const saved = await env.DB.prepare(`
      ${INSERT_PRODUCT_SQL}
      ON CONFLICT (upc) WHERE upc IS NOT NULL
      ${UPSERT_UPDATE_SQL}
      ON CONFLICT (gtin) WHERE gtin IS NOT NULL
      ${UPSERT_UPDATE_SQL}
      RETURNING id
    `)
      .bind(...values)
      .first();

    return { id: saved.id, created: !existing };
  } catch (error) {
    if (
      !/ON CONFLICT clause does not match/i.test(
        String(error && error.message)
      )
    ) {
      throw error;
    }
  }

  // Migration 0002 not applied yet: update or insert by hand.
  console.warn(
    "Unique identifier indexes missing; apply migration 0002."
  );

  if (existing) {
    await env.DB.prepare(`
      UPDATE walmart_products
      SET walmart_price = ?, oos_status = ?, last_checked_at = ?
      WHERE id = ?
    `)
      .bind(product.walmartPrice, product.oosStatus, now, existing.id)
      .run();

    return { id: existing.id, created: false };
  }

  const inserted = await env.DB.prepare(`
    ${INSERT_PRODUCT_SQL}
    RETURNING id
  `)
    .bind(...values)
    .first();

  return { id: inserted.id, created: true };
}

// Oldest first. Capped at the most recent MAX_HISTORY_ROWS changes each.
async function productHistory(env, productId) {
  const product = await env.DB.prepare(
    "SELECT id, detected_at FROM walmart_products WHERE id = ?"
  )
    .bind(productId)
    .first();

  if (!product) {
    return sendJSON({ ok: false, error: "Product not found." }, 404);
  }

  const [prices, costs] = await env.DB.batch([
    env.DB.prepare(`
      SELECT walmart_price AS price, oos_status AS status, recorded_at
      FROM product_history
      WHERE walmart_product_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(productId, MAX_HISTORY_ROWS),
    env.DB.prepare(`
      SELECT
        v.name AS source,
        h.unit_cost AS cost,
        h.shipping_cost AS shipping,
        h.fees AS fees,
        h.available_quantity AS quantity,
        h.recorded_at
      FROM inventory_history h
      JOIN vendor_inventory i ON i.id = h.inventory_item_id
      JOIN vendors v ON v.id = i.vendor_id
      JOIN matches m ON m.inventory_item_id = i.id
      WHERE m.walmart_product_id = ?
      ORDER BY h.id DESC
      LIMIT ?
    `).bind(productId, MAX_HISTORY_ROWS)
  ]);

  return sendJSON({
    ok: true,
    tracked_since: product.detected_at,
    prices: (prices.results || []).reverse(),
    costs: (costs.results || []).reverse()
  });
}

function checksPerRun(env) {
  const n = cleanInteger(env.STOCK_CHECKS_PER_RUN);
  return n === null ? DEFAULT_CHECKS_PER_RUN : clamp(n, 0, MAX_CHECKS_PER_RUN);
}

// Checks one product, or the next batch of least recently checked ones, and
// saves the results. Price and status changes reach the history tables
// through their triggers.
async function runStockChecks(env, trigger, productId = null) {
  const startedAt = new Date().toISOString();
  const select = `
    SELECT id, upc, gtin, walmart_url, walmart_price, oos_status
    FROM walmart_products
  `;
  const found = productId
    ? await env.DB.prepare(select + " WHERE id = ?").bind(productId).all()
    : await env.DB.prepare(select + `
        WHERE upc IS NOT NULL OR gtin IS NOT NULL OR walmart_url LIKE 'https://%walmart.com/ip/%'
        ORDER BY stock_checked_at IS NOT NULL, stock_checked_at, id
        LIMIT ?
      `).bind(checksPerRun(env)).all();
  const products = found.results || [];

  if (!products.length) {
    return { checked: 0, changed: 0, failed: 0, results: [] };
  }

  const run = await env.DB.prepare(
    "INSERT INTO stock_check_runs (trigger, started_at) VALUES (?, ?) RETURNING id"
  )
    .bind(trigger, startedAt)
    .first();

  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < products.length) {
      const product = products[next++];
      results.push(await checkProduct(env, product));
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));

  const checkedAt = new Date().toISOString();
  const statements = results.map((r) => r.ok
    ? env.DB.prepare(`
        UPDATE walmart_products
        SET walmart_price = COALESCE(?, walmart_price),
            oos_status = ?,
            walmart_url = CASE WHEN walmart_url IS NULL OR walmart_url = '' THEN ? ELSE walmart_url END,
            last_checked_at = ?,
            stock_checked_at = ?,
            stock_check_error = NULL
        WHERE id = ?
      `).bind(r.price, r.status, r.url, checkedAt, checkedAt, r.id)
    : env.DB.prepare(
        "UPDATE walmart_products SET stock_checked_at = ?, stock_check_error = ? WHERE id = ?"
      ).bind(checkedAt, r.error, r.id)
  );
  const failures = results.filter((r) => !r.ok);
  const summary = {
    checked: results.length - failures.length,
    changed: results.filter((r) => r.changed).length,
    failed: failures.length
  };

  statements.push(
    env.DB.prepare(`
      UPDATE stock_check_runs
      SET completed_at = ?, checked = ?, changed = ?, failed = ?, error_message = ?
      WHERE id = ?
    `).bind(
      checkedAt,
      summary.checked,
      summary.changed,
      summary.failed,
      failures.length ? failures[0].error : null,
      run.id
    )
  );
  await env.DB.batch(statements);

  return { ...summary, results };
}

async function checkProduct(env, product) {
  const result = { id: product.id, ok: false };

  try {
    const identifiers = [product.upc, product.gtin]
      .map(normalizeIdentifier)
      .filter(Boolean);
    let itemId = walmartItemId(product.walmart_url);
    let foundUrl = null;

    if (!itemId) {
      if (!identifiers.length) {
        return { ...result, error: "Needs a UPC/GTIN or a Walmart URL to check." };
      }

      const search = await serpapi(env, { engine: "walmart", query: identifiers[0] }, true);
      itemId = cleanText(search.organic_results?.[0]?.us_item_id);

      if (!/^\d+$/.test(itemId)) {
        return { ...result, error: "Not found on Walmart by UPC. Add the product's Walmart URL." };
      }

      foundUrl = `https://www.walmart.com/ip/${itemId}`;
    }

    const data = await serpapi(env, { engine: "walmart_product", product_id: itemId });
    const item = data.product_result;

    if (!item || typeof item.in_stock !== "boolean") {
      return { ...result, error: "Walmart returned no stock information for this item." };
    }

    // A UPC search can return a near match; only trust it when the UPC agrees.
    if (foundUrl && item.upc && !identifiers.some((id) => sameIdentifier(id, item.upc))) {
      return { ...result, error: "Walmart's top result for this UPC is a different product. Add the product's Walmart URL." };
    }

    const rawPrice = cleanNumber(item.price_map?.price);
    const price = rawPrice !== null && rawPrice > 0 && rawPrice <= MAX_PRICE ? rawPrice : null;
    const status = !item.in_stock
      ? "Fulfillment/DC OOS"
      : item.shipping_option?.available === false
        ? "Shipping OOS"
        : "In stock";

    return {
      ...result,
      ok: true,
      price,
      status,
      url: foundUrl,
      changed: status !== product.oos_status ||
        (price !== null && price !== product.walmart_price)
    };
  } catch (error) {
    return { ...result, error: error.message.slice(0, 200) };
  }
}

// emptyOk: a search with no results comes back as an "error" from SerpApi.
async function serpapi(env, params, emptyOk = false) {
  const url = new URL(SERPAPI_URL);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set("api_key", env.SERPAPI_KEY);

  const response = await fetch(url, { headers: { accept: "application/json" } });
  let data = null;

  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  const message = cleanText(data?.error);

  if (emptyOk && response.ok && /hasn't returned any results/i.test(message)) {
    return {};
  }

  if (!response.ok || message || !data) {
    throw new Error("SerpApi: " + (message || `HTTP ${response.status}`));
  }

  return data;
}

// The numeric item id in a walmart.com/ip/<slug>/<id> URL.
function walmartItemId(value) {
  const text = cleanText(value);

  if (!text || !isWalmartUrl(text)) {
    return null;
  }

  const match = new URL(text).pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)\/?$/);
  return match ? match[1] : null;
}

// Walmart sometimes drops leading zeros or the check digit from a UPC.
function sameIdentifier(ours, theirs) {
  const a = ours.replace(/^0+/, "");
  const b = cleanText(theirs).replace(/\D/g, "").replace(/^0+/, "");

  return Boolean(b) && (a === b || a.slice(0, -1) === b || b.slice(0, -1) === a);
}

// The cleaned layout, or an error message string.
function validateLayout(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Send a mapping object.";
  }

  const mapping = {};

  for (const field of LAYOUT_FIELDS) {
    const header = cleanText(raw[field]).toLowerCase();

    if (header.length > MAX_ROW_TEXT_LENGTH) {
      return "Column names must be " + MAX_ROW_TEXT_LENGTH + " characters or fewer.";
    }

    if (header) {
      mapping[field] = header;
    }
  }

  if (!mapping.cost || !(mapping.upc || mapping.gtin)) {
    return "A layout needs a cost column and a UPC or GTIN column.";
  }

  return mapping;
}

// Validates every row, then upserts the valid ones in one batch.
// Errors carry the row's index in the request so the dashboard can
// point at the CSV line.
async function importProducts(env, data) {
  const incoming = Array.isArray(data.products) ? data.products : null;

  if (!incoming || !incoming.length) {
    return sendJSON(
      { ok: false, error: "Send a products array with at least one product." },
      400
    );
  }

  if (incoming.length > MAX_PRODUCTS_PER_IMPORT) {
    return sendJSON(
      {
        ok: false,
        error: `Send at most ${MAX_PRODUCTS_PER_IMPORT} products per request.`
      },
      413
    );
  }

  const errors = [];
  // Later rows for the same UPC/GTIN win, like saving twice.
  const byKey = new Map();
  const withoutKey = [];

  incoming.forEach((raw, index) => {
    const validated = validateProduct(
      raw && typeof raw === "object" ? raw : {}
    );

    if (validated.error) {
      errors.push({ index, error: validated.error });
      return;
    }

    const product = validated.product;

    if (product.upc || product.gtin) {
      byKey.set(product.upc ? "u" + product.upc : "g" + product.gtin, product);
    } else {
      withoutKey.push(product);
    }
  });

  const products = [...byKey.values(), ...withoutKey];

  if (!products.length) {
    return sendJSON({
      ok: true,
      added: 0,
      updated: 0,
      error_count: errors.length,
      errors: errors.slice(0, MAX_IMPORT_ERRORS)
    });
  }

  const existing = await loadExistingIdentifiers(env, products);
  const now = new Date().toISOString();

  try {
    await env.DB.batch(
      products.map((p) =>
        env.DB.prepare(`
          ${INSERT_PRODUCT_SQL}
          ON CONFLICT (upc) WHERE upc IS NOT NULL
          ${UPSERT_UPDATE_SQL}
          ON CONFLICT (gtin) WHERE gtin IS NOT NULL
          ${UPSERT_UPDATE_SQL}
        `).bind(
          p.title,
          p.upc,
          p.gtin,
          p.mpn,
          p.walmartPrice,
          p.walmartUrl,
          p.bestsellerRank,
          p.reviewCount,
          p.oosStatus,
          now,
          now
        )
      )
    );
  } catch (error) {
    if (
      /ON CONFLICT clause does not match/i.test(
        String(error && error.message)
      )
    ) {
      console.error("Importing products failed: apply migration 0002.");
      return sendJSON(
        {
          ok: false,
          error: "Bulk import needs the unique UPC/GTIN indexes. Apply the D1 migrations, then try again."
        },
        503
      );
    }

    throw error;
  }

  const updated = products.filter(
    (p) =>
      (p.upc && existing.has("u" + p.upc)) ||
      (p.gtin && existing.has("g" + p.gtin))
  ).length;

  return sendJSON({
    ok: true,
    added: products.length - updated,
    updated,
    error_count: errors.length,
    errors: errors.slice(0, MAX_IMPORT_ERRORS)
  });
}

// "u<upc>" and "g<gtin>" for products already in D1.
async function loadExistingIdentifiers(env, products) {
  const ids = [
    ...new Set(
      products.flatMap((p) => [p.upc, p.gtin]).filter(Boolean)
    )
  ];
  const found = new Set();
  // Each chunk is bound twice (upc and gtin), so use half the limit.
  const size = Math.floor(MAX_IN_PARAMS / 2);

  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    const marks = chunk.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT upc, gtin FROM walmart_products
       WHERE upc IN (${marks}) OR gtin IN (${marks})`
    )
      .bind(...chunk, ...chunk)
      .all();

    for (const row of result.results || []) {
      if (row.upc) found.add("u" + row.upc);
      if (row.gtin) found.add("g" + row.gtin);
    }
  }

  return found;
}

// Offers newest first, shaped like the rows /api/rank takes.
// Keyset pagination: pass ?before=<match id> from next_before.
async function listOffers(env, url) {
  const limit = clamp(
    cleanInteger(url.searchParams.get("limit")) ??
      DEFAULT_OFFER_PAGE_SIZE,
    1,
    MAX_OFFER_PAGE_SIZE
  );
  const before = cleanInteger(url.searchParams.get("before"));

  const result = await env.DB.prepare(`
    SELECT
      m.id AS match_id,
      m.walmart_product_id AS pid,
      v.name AS source,
      i.unit_cost AS cost,
      i.shipping_cost AS shipping,
      i.fees AS fees,
      i.available_quantity AS quantity,
      i.moq AS moq,
      i.condition AS condition,
      m.match_confidence AS confidence,
      m.match_method AS match,
      i.imported_at AS imported_at
    FROM matches m
    JOIN vendor_inventory i ON i.id = m.inventory_item_id
    JOIN vendors v ON v.id = i.vendor_id
    WHERE i.active = 1
      AND (?1 IS NULL OR m.id < ?1)
    ORDER BY m.id DESC
    LIMIT ?2
  `)
    .bind(before, limit)
    .all();

  const offers = result.results || [];

  return {
    ok: true,
    offers,
    next_before:
      offers.length === limit
        ? offers[offers.length - 1].match_id
        : null
  };
}

// Saves offers for tracked products. One offer per product and
// supplier: importing again for the same pair replaces it.
async function importOffers(env, data) {
  const incoming = Array.isArray(data.offers) ? data.offers : null;

  if (!incoming || !incoming.length) {
    return sendJSON(
      { ok: false, error: "Send an offers array with at least one offer." },
      400
    );
  }

  if (incoming.length > MAX_OFFERS_PER_REQUEST) {
    return sendJSON(
      {
        ok: false,
        error: `Send at most ${MAX_OFFERS_PER_REQUEST} offers per request.`
      },
      413
    );
  }

  const vendorRows = await env.DB.prepare(
    "SELECT id, name FROM vendors"
  ).all();
  const vendorByName = new Map(
    (vendorRows.results || []).map((v) => [v.name.toLowerCase(), v])
  );
  const fallbackVendor = vendorByName.get("custom manifest");

  if (!fallbackVendor) {
    console.error("Saving offers failed: vendors table is not seeded.");
    return sendJSON(
      {
        ok: false,
        error: "The supplier list is not set up in the database yet. Apply the D1 migrations, then try again."
      },
      503
    );
  }

  const productById = await loadProductsById(
    env,
    incoming.map((o) => cleanInteger(o && o.pid))
  );

  const skipped = { no_product: 0, invalid: 0 };
  let unknownSources = 0;
  const byPair = new Map();

  for (const raw of incoming) {
    const offer = validateOffer(raw);

    if (!offer) {
      skipped.invalid++;
      continue;
    }

    const product = productById.get(offer.pid);
    const identifier = product && (product.upc || product.gtin);

    if (!identifier) {
      skipped.no_product++;
      continue;
    }

    let vendor = vendorByName.get(offer.source.toLowerCase());

    if (!vendor) {
      if (offer.source) unknownSources++;
      vendor = fallbackVendor;
    }

    byPair.set(offer.pid + "|" + vendor.id, {
      ...offer,
      product,
      identifier,
      vendor
    });
  }

  const offers = [...byPair.values()];

  if (!offers.length) {
    return sendJSON({
      ok: true,
      imported: 0,
      replaced: 0,
      skipped,
      unknown_sources: unknownSources
    });
  }

  const existing = await loadExistingPairs(
    env,
    [...new Set(offers.map((o) => o.pid))]
  );
  const now = new Date().toISOString();

  const inventoryResults = await env.DB.batch(
    offers.map((o) =>
      env.DB.prepare(`
        INSERT INTO vendor_inventory (
          vendor_id, upc, gtin, mpn, title, condition,
          unit_cost, shipping_cost, fees,
          available_quantity, moq, imported_at, active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (vendor_id, upc) WHERE upc IS NOT NULL
        DO UPDATE SET
          gtin = excluded.gtin,
          mpn = excluded.mpn,
          title = excluded.title,
          condition = excluded.condition,
          unit_cost = excluded.unit_cost,
          shipping_cost = excluded.shipping_cost,
          fees = excluded.fees,
          available_quantity = excluded.available_quantity,
          moq = excluded.moq,
          imported_at = excluded.imported_at,
          active = 1
        RETURNING id
      `).bind(
        o.vendor.id,
        o.identifier,
        o.product.gtin || null,
        o.product.mpn || null,
        o.product.title,
        o.condition,
        o.cost,
        o.shipping,
        o.fees,
        o.quantity,
        o.moq,
        now
      )
    )
  );

  await env.DB.batch(
    offers.map((o, i) =>
      env.DB.prepare(`
        INSERT INTO matches (
          walmart_product_id, inventory_item_id,
          match_method, match_confidence, calculated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (walmart_product_id, inventory_item_id)
        DO UPDATE SET
          match_method = excluded.match_method,
          match_confidence = excluded.match_confidence,
          calculated_at = excluded.calculated_at
      `).bind(
        o.pid,
        inventoryResults[i].results[0].id,
        o.match,
        o.confidence,
        now
      )
    )
  );

  const replaced = offers.filter((o) =>
    existing.has(o.pid + "|" + o.vendor.id)
  ).length;

  return sendJSON({
    ok: true,
    imported: offers.length,
    replaced,
    skipped,
    unknown_sources: unknownSources
  });
}

// null when the offer is unusable. Mirrors parseOffer in index.html.
function validateOffer(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const pid = cleanInteger(raw.pid);
  const cost = cleanNumber(raw.cost);
  const shipping = cleanNumber(raw.shipping) ?? 0;
  const fees = cleanNumber(raw.fees) ?? 0;
  const quantity = cleanCount(raw.quantity);
  const moq = cleanCount(raw.moq) ?? 1;
  const confidence = cleanNumber(raw.confidence);

  if (
    pid === null || pid < 1 ||
    cost === null || cost < 0 || cost > MAX_PRICE ||
    shipping < 0 || shipping > MAX_PRICE ||
    fees < 0 || fees > MAX_PRICE ||
    quantity === false ||
    moq === false || moq < 1 ||
    confidence === null || confidence < 0 || confidence > 100
  ) {
    return null;
  }

  return {
    pid,
    source: cleanText(raw.source).slice(0, MAX_ROW_TEXT_LENGTH),
    cost,
    shipping,
    fees,
    quantity,
    moq,
    condition:
      cleanText(raw.condition).slice(0, MAX_ROW_TEXT_LENGTH) ||
      "Unknown",
    confidence,
    match:
      cleanText(raw.match).slice(0, MAX_ROW_TEXT_LENGTH) ||
      "Imported UPC"
  };
}

async function loadProductsById(env, ids) {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  const byId = new Map();

  for (let i = 0; i < unique.length; i += MAX_IN_PARAMS) {
    const chunk = unique.slice(i, i + MAX_IN_PARAMS);
    const result = await env.DB.prepare(
      `SELECT id, title, upc, gtin, mpn FROM walmart_products
       WHERE id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all();

    for (const row of result.results || []) {
      byId.set(row.id, row);
    }
  }

  return byId;
}

// "pid|vendor_id" for every offer already stored for these products.
async function loadExistingPairs(env, pids) {
  const pairs = new Set();

  for (let i = 0; i < pids.length; i += MAX_IN_PARAMS) {
    const chunk = pids.slice(i, i + MAX_IN_PARAMS);
    const result = await env.DB.prepare(
      `SELECT m.walmart_product_id AS pid, i.vendor_id AS vendor_id
       FROM matches m
       JOIN vendor_inventory i ON i.id = m.inventory_item_id
       WHERE m.walmart_product_id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all();

    for (const row of result.results || []) {
      pairs.add(row.pid + "|" + row.vendor_id);
    }
  }

  return pairs;
}

function rankGroup(group, settings) {
  const sellPrice = cleanNumber(group.sell);
  const validSell = sellPrice !== null && sellPrice > 0;

  const rankedRows = group.rows
    .map((row) => rankOffer(row, validSell ? sellPrice : 0))
    .sort((a, b) => b.score - a.score);

  rankedRows.forEach((row) => {
    row.problems = offerProblems(row, settings, validSell);
  });

  const validRows = rankedRows.filter(
    (row) => row.problems.length === 0
  );

  rankedRows.forEach((row) => {
    const place = validRows.indexOf(row);

    if (place === 0) {
      row.color = "green";
      row.decision = "Best source";
      row.reason = validRows.length > 1
        ? "Highest-scoring offer that meets your filters."
        : "Only offer that meets your filters.";
    } else if (place === 1) {
      row.color = "yellow";
      row.decision = "Backup source";
      row.reason = "2nd-best offer that meets your filters.";
    } else {
      row.color = "red";
      row.decision = "Pass";
      row.reason = place > 1
        ? `${ordinal(place + 1)}-best offer — only the top two are kept.`
        : row.problems.join(" ");
    }

    delete row.problems;
  });

  return rankedRows;
}

function offerProblems(row, settings, validSell) {
  const problems = [];

  if (!validSell) {
    problems.push("Walmart price is missing or invalid.");
  }

  if (row.cost === null) {
    problems.push("Supplier cost is missing or invalid.");
  }

  if (row.invalidCosts) {
    problems.push("Shipping or fees are negative or invalid.");
  }

  if (!PREFERRED_CONDITIONS.includes(row.condition.toLowerCase())) {
    problems.push(
      `${row.condition} condition — not eligible (New or Overstock only).`
    );
  }

  if (row.margin < settings.minMargin) {
    problems.push(
      `Margin ${row.margin}% is below your ${settings.minMargin}% minimum.`
    );
  }

  if (row.confidence < settings.minConfidence) {
    problems.push(
      `Match confidence ${row.confidence}% is below your ${settings.minConfidence}% minimum.`
    );
  }

  if (settings.maxMoq !== null && row.moq > settings.maxMoq) {
    problems.push(
      `MOQ ${row.moq} is above your max of ${settings.maxMoq}.`
    );
  }

  if (row.quantity !== null && row.quantity < row.moq) {
    problems.push(
      `Only ${row.quantity} in stock — below the MOQ of ${row.moq}.`
    );
  }

  return problems;
}

function rankOffer(row, sellPrice) {
  const input = row && typeof row === "object" ? row : {};

  const cost = cleanNumber(input.cost);
  const shipping = cleanNumber(input.shipping) ?? 0;
  const fees = cleanNumber(input.fees) ?? 0;
  const validCost = cost !== null && cost >= 0 ? cost : null;
  const invalidCosts =
    shipping < 0 ||
    fees < 0 ||
    (input.shipping !== undefined &&
      input.shipping !== null &&
      input.shipping !== "" &&
      cleanNumber(input.shipping) === null) ||
    (input.fees !== undefined &&
      input.fees !== null &&
      input.fees !== "" &&
      cleanNumber(input.fees) === null);

  const landed =
    (validCost ?? 0) + Math.max(0, shipping) + Math.max(0, fees);
  const profit = sellPrice - landed;

  const margin = sellPrice > 0
    ? (profit / sellPrice) * 100
    : 0;

  // Missing or unparseable confidence counts as no confidence.
  const confidence = clamp(
    cleanNumber(input.confidence) ?? 0,
    0,
    100
  );

  const moq = Math.max(1, cleanInteger(input.moq) ?? 1);
  const quantityValue = cleanInteger(input.quantity);
  const quantity =
    quantityValue === null ? null : Math.max(0, quantityValue);

  const condition =
    cleanText(input.condition).slice(0, MAX_ROW_TEXT_LENGTH) ||
    "Unknown";

  const preferredCondition = PREFERRED_CONDITIONS.includes(
    condition.toLowerCase()
  );

  // Up to 40 for confidence, 45 for margin (full at 40%),
  // 15 for condition, minus MOQ and low-stock penalties.
  let score =
    confidence * 0.4 +
    (clamp(margin, 0, 40) / 40) * 45 +
    (preferredCondition ? 15 : 0) -
    Math.min(10, moq / 50) -
    (quantity !== null && quantity < moq ? 20 : 0);

  if (validCost === null) {
    score = 0;
  }

  score = clamp(score, 0, 100);

  return {
    pid: cleanGroupId(input.pid),
    source: cleanText(input.source).slice(0, MAX_ROW_TEXT_LENGTH),
    match: cleanText(input.match).slice(0, MAX_ROW_TEXT_LENGTH),
    cost: validCost,
    shipping: Math.max(0, shipping),
    fees: Math.max(0, fees),
    quantity,
    invalidCosts,
    landed: Number(landed.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    margin: Number(margin.toFixed(1)),
    confidence,
    moq,
    condition,
    score: Math.round(score)
  };
}

function ordinal(n) {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";

  return n + suffix;
}

function isWalmartUrl(value) {
  if (value.length > MAX_URL_LENGTH) {
    return false;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    return (
      parsed.protocol === "https:" &&
      (host === "walmart.com" || host.endsWith(".walmart.com"))
    );
  } catch (error) {
    return false;
  }
}

function cleanGroupId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return cleanText(value).slice(0, 40);
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

// Digits only. Lengths 9-11 are padded back to a 12-digit UPC
// (spreadsheets often drop leading zeros). Returns "" when empty
// and false when the value is not a plausible UPC/EAN/GTIN.
// The dashboard uses the same rule (normalizeId in index.html).
function normalizeIdentifier(value) {
  const digits = cleanText(value).replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length < 8 || digits.length > 14) {
    return false;
  }

  return digits.length > 8 && digits.length < 12
    ? digits.padStart(12, "0")
    : digits;
}

function cleanNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(
    String(value).replace(/[$,% ]/g, "")
  );

  return Number.isFinite(number)
    ? number
    : null;
}

function cleanInteger(value) {
  const number = cleanNumber(value);

  if (number === null) {
    return null;
  }

  return Math.round(number);
}

// null when empty, false when negative or not a number.
function cleanCount(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = cleanInteger(value);

  if (number === null || number < 0 || number > MAX_COUNT) {
    return false;
  }

  return number;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tooLarge(maxBytes) {
  return sendJSON(
    {
      ok: false,
      error: `Request body must be ${Math.round(maxBytes / 1024)} KB or smaller.`
    },
    413
  );
}

function methodNotAllowed(allowed) {
  const response = sendJSON(
    { ok: false, error: "Method not allowed." },
    405
  );

  response.headers.set("allow", allowed);
  return response;
}

function serverError(label, error) {
  console.error(label + ":", error);

  return sendJSON(
    {
      ok: false,
      error: "Something went wrong on the server. Please try again."
    },
    500
  );
}

function sendJSON(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8",
        "cache-control": "no-store",
        ...SECURITY_HEADERS
      }
    }
  );
}
