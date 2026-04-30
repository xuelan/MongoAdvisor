#!/usr/bin/env node
/**
 * Builds `sample_airbnb.listingsAndReviews_big` from `listingsAndReviews` by repeating each
 * document N times using `$addFields` → `$range` → `$unwind`. Each copy gets a new string `_id`
 * (`<originalId>::<slot>`) so the target collection is valid for writes.
 *
 * Run once (or again to refresh) before `workload-agg.js` / `workload-agg2.js`, which read
 * `listingsAndReviews_big`.
 *
 * Prerequisites: Atlas [sample data](https://www.mongodb.com/docs/atlas/sample-data/load-sample-data/#std-label-load-sample-data)
 * loaded so `sample_airbnb.listingsAndReviews` exists. `$out` requires **write** access (e.g. user
 * created with `npm run atlas:create-user -- --preset workload` → `readWriteAnyDatabase`; not `metrics_reader`).
 *
 * Usage:
 *   node scripts/airbnb-expand-listings-big.js       # default N = 10
 *   node scripts/airbnb-expand-listings-big.js 25
 *
 * Env: `MONGO_URI` or `WORKLOAD_MONGO_URI` (see `scripts/workload-uri.js`). Optional: `AIRBNB_EXPAND_TIMES` if no argv (same default 10).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");
const { resolveWorkloadMongoUri } = require("./workload-uri");

const baseUri = resolveWorkloadMongoUri();
if (!baseUri) {
  console.error("Set MONGO_URI or WORKLOAD_MONGO_URI in .env");
  process.exit(1);
}

const argvTimes = process.argv[2];
const raw =
  argvTimes !== undefined && argvTimes !== ""
    ? argvTimes
    : process.env.AIRBNB_EXPAND_TIMES || "10";
const times = parseInt(String(raw), 10);
if (!Number.isFinite(times) || times < 1) {
  console.error("times must be a positive integer (argv or AIRBNB_EXPAND_TIMES)");
  process.exit(1);
}
if (times > 500) {
  console.error("times is capped at 500 for safety; pass a smaller value.");
  process.exit(1);
}

const uri =
  baseUri +
  (baseUri.includes("?") ? "&" : "?") +
  "appName=mongoadvisor-airbnb-expand&readPreference=primary";

async function main() {
  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    connectTimeoutMS: 30_000,
    serverSelectionTimeoutMS: 30_000,
  });

  try {
    await client.connect();
    const db = client.db("sample_airbnb");
    const src = db.collection("listingsAndReviews");
    const srcCount = await src.countDocuments();
    if (srcCount === 0) {
      console.error('sample_airbnb.listingsAndReviews is empty — load Atlas sample data first.');
      process.exit(1);
    }

    console.log(`Source sample_airbnb.listingsAndReviews: ${srcCount} documents`);
    console.log(`Building listingsAndReviews_big with ${times}x expansion (~${srcCount * times} rows)…`);

    const pipeline = [
      { $addFields: { __dupSlot: { $range: [0, times] } } },
      { $unwind: "$__dupSlot" },
      {
        $set: {
          _id: {
            $concat: [{ $toString: "$_id" }, "::", { $toString: "$__dupSlot" }],
          },
        },
      },
      { $unset: "__dupSlot" },
      { $out: "listingsAndReviews_big" },
    ];

    const start = Date.now();
    await src.aggregate(pipeline, { allowDiskUse: true }).toArray();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const outCount = await db.collection("listingsAndReviews_big").countDocuments();
    console.log(`Done in ${elapsed}s — sample_airbnb.listingsAndReviews_big now has ${outCount} documents.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
