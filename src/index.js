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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Check whether the Worker and D1 database are connected.
    if (url.pathname === "/api/health") {
      try {
        await env.DB.prepare(
          "SELECT 1 AS database_test"
        ).first();

        return sendJSON({
          ok: true,
          version: "2.1",
          database: "connected"
        });
      } catch (error) {
        return sendJSON(
          {
            ok: false,
            version: "2.1",
            database: "not connected",
            error: error.message
          },
          500
        );
      }
    }

    // Return the supplier list.
    if (
      url.pathname === "/api/sources" &&
      request.method === "GET"
    ) {
      return sendJSON({ sources });
    }

    // Retrieve Walmart OOS products from D1.
    if (
      url.pathname === "/api/products" &&
      request.method === "GET"
    ) {
      try {
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
          ORDER BY id DESC
        `).all();

        return sendJSON({
          ok: true,
          products: result.results || []
        });
      } catch (error) {
        return sendJSON(
          {
            ok: false,
            error: error.message
          },
          500
        );
      }
    }

    // Save a Walmart OOS product into D1.
    if (
      url.pathname === "/api/products" &&
      request.method === "POST"
    ) {
      try {
        const product = await request.json();

        const title = cleanText(product.title);
        const upc = cleanIdentifier(product.upc);
        const gtin = cleanIdentifier(product.gtin);
        const mpn = cleanText(product.mpn);
        const walmartPrice = cleanNumber(product.walmart_price);
        const walmartUrl = cleanText(product.walmart_url);
        const bestsellerRank = cleanInteger(
          product.bestseller_rank
        );
        const reviewCount = cleanInteger(
          product.review_count
        );
        const oosStatus =
          cleanText(product.oos_status) ||
          "Fulfillment/DC OOS";

        if (!title) {
          return sendJSON(
            {
              ok: false,
              error: "Product title is required."
            },
            400
          );
        }

        if (!upc && !gtin && !mpn) {
          return sendJSON(
            {
              ok: false,
              error: "UPC, GTIN, or MPN is required."
            },
            400
          );
        }

        if (walmartPrice === null || walmartPrice <= 0) {
          return sendJSON(
            {
              ok: false,
              error: "A valid Walmart price is required."
            },
            400
          );
        }

        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
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
        `)
          .bind(
            title,
            upc || null,
            gtin || null,
            mpn || null,
            walmartPrice,
            walmartUrl || null,
            bestsellerRank,
            reviewCount,
            oosStatus,
            now,
            now
          )
          .run();

        return sendJSON(
          {
            ok: true,
            message: "Product saved to SourceMatch D1.",
            product_id: result.meta.last_row_id
          },
          201
        );
      } catch (error) {
        return sendJSON(
          {
            ok: false,
            error: error.message
          },
          500
        );
      }
    }

    // Rank supplier offers for a product.
    if (
      url.pathname === "/api/rank" &&
      request.method === "POST"
    ) {
      try {
        const data = await request.json();
        const sellPrice = cleanNumber(data.sell) || 0;
        const rows = Array.isArray(data.rows)
          ? data.rows
          : [];

        const rankedRows = rows
          .map((row) => rankOffer(row, sellPrice))
          .sort((a, b) => b.score - a.score);

        const validRows = rankedRows.filter((row) => {
          const unsafeConditions = [
            "returns",
            "salvage",
            "damaged"
          ];

          return (
            row.confidence >= 90 &&
            row.margin >= 15 &&
            !unsafeConditions.includes(
              row.condition.toLowerCase()
            )
          );
        });

        rankedRows.forEach((row) => {
          if (row === validRows[0]) {
            row.color = "green";
            row.decision = "Best source";
          } else if (row === validRows[1]) {
            row.color = "yellow";
            row.decision = "Backup source";
          } else {
            row.color = "red";
            row.decision = "Pass";
          }
        });

        return sendJSON({ rows: rankedRows });
      } catch (error) {
        return sendJSON(
          {
            ok: false,
            error: error.message
          },
          500
        );
      }
    }

    // Serve the SourceMatch dashboard.
    return env.ASSETS.fetch(request);
  }
};

function rankOffer(row, sellPrice) {
  const cost = cleanNumber(row.cost) || 0;
  const shipping = cleanNumber(row.shipping) || 0;
  const fees = cleanNumber(row.fees) || 0;
  const landed = cost + shipping + fees;
  const profit = sellPrice - landed;

  const margin = sellPrice > 0
    ? (profit / sellPrice) * 100
    : 0;

  const confidence =
    cleanNumber(row.confidence) || 100;

  const moq =
    cleanInteger(row.moq) || 1;

  const condition =
    cleanText(row.condition) || "Unknown";

  const preferredCondition = [
    "new",
    "overstock"
  ].includes(condition.toLowerCase());

  let score =
    confidence * 0.4 +
    Math.min(35, Math.max(0, margin)) * 0.8 -
    Math.min(12, moq / 50) +
    (preferredCondition ? 12 : -6);

  score = Math.max(0, Math.min(100, score));

  return {
    ...row,
    landed: Number(landed.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    margin: Number(margin.toFixed(1)),
    confidence,
    moq,
    condition,
    score: Math.round(score)
  };
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function cleanIdentifier(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).replace(/\D/g, "");
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
    String(value).replace(/[$,% ,]/g, "")
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

function sendJSON(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8"
      }
    }
  );
}
