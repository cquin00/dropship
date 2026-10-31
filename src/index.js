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
  "Low stock risk"
];

const PREFERRED_CONDITIONS = ["new", "overstock"];

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
            last_checked_at
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

    // Any other /api/* path is not an endpoint.
    if (url.pathname.startsWith("/api/")) {
      return sendJSON(
        { ok: false, error: "Not found." },
        404
      );
    }

    // Serve the SourceMatch dashboard.
    return env.ASSETS.fetch(request);
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
