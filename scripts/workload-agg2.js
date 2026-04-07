require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME = "workload-b";
const COMMENT = "Airbnb seasonal pricing: unwind reviews, bucket by month, facet top/bottom markets";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);
const uri = baseUri + (baseUri.includes("?") ? "&" : "?") + `appName=${APP_NAME}&readPreference=${readPref}`;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const limitN = rand(15, 60);
const sortField = pick(["total_reviews", "avg_price", "demand_density", "total_listings"]);

const pipeline = [
  {
    $match: {
      reviews: { $exists: true, $ne: [] },
      price: { $exists: true },
      "address.market": { $exists: true, $ne: "" },
    },
  },

  // Stage 2 (slow): unwind the reviews array — expands 55k docs into millions of rows
  { $unwind: "$reviews" },

  // Stage 3 (medium): $addFields — extract temporal and pricing dimensions
  {
    $addFields: {
      review_month: { $month: "$reviews.date" },
      review_year: { $year: "$reviews.date" },
      review_day_of_week: { $dayOfWeek: "$reviews.date" },
      price_numeric: { $toDouble: "$price" },
      price_per_guest: {
        $cond: {
          if: { $gt: ["$accommodates", 0] },
          then: { $round: [{ $divide: [{ $toDouble: "$price" }, "$accommodates"] }, 2] },
          else: { $toDouble: "$price" },
        },
      },
      has_pool: {
        $in: ["Pool", { $ifNull: ["$amenities", []] }],
      },
      is_superhost: { $ifNull: ["$host.host_is_superhost", false] },
    },
  },

  // Stage 4 (slow): $group — aggregate by market, month, room_type
  {
    $group: {
      _id: {
        market: "$address.market",
        month: "$review_month",
        room_type: "$room_type",
      },
      avg_price: { $avg: "$price_numeric" },
      avg_price_per_guest: { $avg: "$price_per_guest" },
      min_price: { $min: "$price_numeric" },
      max_price: { $max: "$price_numeric" },
      review_count: { $sum: 1 },
      unique_listings: { $addToSet: "$_id" },
      avg_bedrooms: { $avg: "$bedrooms" },
      pool_listings: { $sum: { $cond: ["$has_pool", 1, 0] } },
      superhost_reviews: { $sum: { $cond: ["$is_superhost", 1, 0] } },
      weekend_reviews: {
        $sum: { $cond: [{ $in: ["$review_day_of_week", [1, 7]] }, 1, 0] },
      },
    },
  },

  // Stage 5 (medium): $addFields — compute derived metrics from group
  {
    $addFields: {
      listing_count: { $size: "$unique_listings" },
      price_spread: { $subtract: ["$max_price", "$min_price"] },
      superhost_review_ratio: {
        $round: [{ $divide: ["$superhost_reviews", { $max: ["$review_count", 1] }] }, 2],
      },
      weekend_ratio: {
        $round: [{ $divide: ["$weekend_reviews", { $max: ["$review_count", 1] }] }, 2],
      },
      season: {
        $switch: {
          branches: [
            { case: { $in: ["$_id.month", [12, 1, 2]] }, then: "winter" },
            { case: { $in: ["$_id.month", [3, 4, 5]] }, then: "spring" },
            { case: { $in: ["$_id.month", [6, 7, 8]] }, then: "summer" },
          ],
          default: "autumn",
        },
      },
    },
  },

  // Stage 6 (fast): $project — drop the heavy unique_listings set, shape output
  {
    $project: {
      _id: 0,
      market: "$_id.market",
      month: "$_id.month",
      room_type: "$_id.room_type",
      season: 1,
      listing_count: 1,
      review_count: 1,
      avg_price: { $round: ["$avg_price", 2] },
      avg_price_per_guest: { $round: ["$avg_price_per_guest", 2] },
      price_spread: { $round: ["$price_spread", 2] },
      avg_bedrooms: { $round: ["$avg_bedrooms", 1] },
      superhost_review_ratio: 1,
      weekend_ratio: 1,
    },
  },

  // Stage 7 (slow): $group — re-aggregate by market + season for seasonal summary
  {
    $group: {
      _id: { market: "$market", season: "$season" },
      total_reviews: { $sum: "$review_count" },
      total_listings: { $sum: "$listing_count" },
      avg_price: { $avg: "$avg_price" },
      avg_price_per_guest: { $avg: "$avg_price_per_guest" },
      avg_price_spread: { $avg: "$price_spread" },
      avg_superhost_ratio: { $avg: "$superhost_review_ratio" },
      avg_weekend_ratio: { $avg: "$weekend_ratio" },
    },
  },

  // Stage 8 (fast): $addFields — demand density metric
  {
    $addFields: {
      demand_density: {
        $round: [{ $divide: ["$total_reviews", { $max: ["$total_listings", 1] }] }, 1],
      },
    },
  },

  { $sort: { [sortField]: -1 } },

  { $limit: limitN },
];

async function main() {
  const client = new MongoClient(uri, {
    maxPoolSize: 3,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    await client.connect();
    const db = client.db("sample_airbnb");

    console.log(`Running seasonal pricing aggregation (sort=${sortField}, limit=${limitN})…\n`);
    const start = Date.now();

    const results = await db
      .collection("listingsAndReviews_big")
      .aggregate(pipeline, { allowDiskUse: true, comment: COMMENT })
      .toArray();

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Completed in ${elapsed}s — ${results.length} market-season segments\n`);

    console.log("Top 15 market-season segments by review volume:");
    console.log("─".repeat(110));
    console.log(
      "Market".padEnd(22),
      "Season".padEnd(8),
      "Reviews".padStart(8),
      "Listings".padStart(9),
      "Demand".padStart(7),
      "AvgPrice".padStart(9),
      "$/Guest".padStart(8),
      "Spread".padStart(8),
      "SH%".padStart(5),
      "Wknd%".padStart(6),
    );
    console.log("─".repeat(110));

    for (const r of results.slice(0, 15)) {
      console.log(
        (r._id.market || "?").padEnd(22),
        (r._id.season || "?").padEnd(8),
        String(r.total_reviews).padStart(8),
        String(r.total_listings).padStart(9),
        String(r.demand_density).padStart(7),
        String(r.avg_price.toFixed(0)).padStart(9),
        String(r.avg_price_per_guest.toFixed(0)).padStart(8),
        String(r.avg_price_spread.toFixed(0)).padStart(8),
        String(r.avg_superhost_ratio.toFixed(2)).padStart(5),
        String(r.avg_weekend_ratio.toFixed(2)).padStart(6),
      );
    }
  } finally {
    await client.close();
    console.log("\nConnection closed");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
