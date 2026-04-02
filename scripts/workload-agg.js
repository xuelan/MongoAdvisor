require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME = "workload-agg";
const COMMENT = "Airbnb 10-stage analytics: match, lookup host listings, map reviews, group by country/type/tier";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const uri = baseUri + (baseUri.includes("?") ? "&" : "?") + `appName=${APP_NAME}`;

const pipeline = [
  // Stage 1 (fast): filter listings with reviews and reasonable price
  {
    $match: {
      number_of_reviews: { $gte: 5 },
      bedrooms: { $gte: 1 },
      "address.country": { $exists: true },
    },
  },

  // Stage 2 (slow): $lookup — find other listings by the same host
  {
    $lookup: {
      from: "listingsAndReviews",
      localField: "host.host_id",
      foreignField: "host.host_id",
      as: "host_other_listings",
    },
  },

  // Stage 3 (medium): $addFields — heavy $map over reviews array
  {
    $addFields: {
      review_summary: {
        $map: {
          input: { $slice: ["$reviews", 20] },
          as: "r",
          in: {
            reviewer: "$$r.reviewer_name",
            month: { $month: "$$r.date" },
            year: { $year: "$$r.date" },
            comment_length: { $strLenCP: { $ifNull: ["$$r.comments", ""] } },
          },
        },
      },
      amenity_count: { $size: { $ifNull: ["$amenities", []] } },
      host_portfolio_size: { $size: "$host_other_listings" },
      price_numeric: { $toDouble: "$price" },
      cleaning_fee_numeric: { $toDouble: { $ifNull: ["$cleaning_fee", "0"] } },
    },
  },

  // Stage 4 (fast): $project — shape output, drop heavy fields
  {
    $project: {
      name: 1,
      property_type: 1,
      room_type: 1,
      country: "$address.country",
      market: "$address.market",
      accommodates: 1,
      bedrooms: 1,
      price_numeric: 1,
      cleaning_fee_numeric: 1,
      total_cost: { $add: ["$price_numeric", "$cleaning_fee_numeric"] },
      number_of_reviews: 1,
      amenity_count: 1,
      host_portfolio_size: 1,
      host_is_superhost: "$host.host_is_superhost",
      avg_comment_length: { $avg: "$review_summary.comment_length" },
      review_scores_rating: "$review_scores.review_scores_rating",
    },
  },

  // Stage 5 (medium): $addFields — compute value score and tier
  {
    $addFields: {
      value_score: {
        $cond: {
          if: { $gt: ["$total_cost", 0] },
          then: {
            $round: [
              { $multiply: [{ $divide: ["$review_scores_rating", "$total_cost"] }, 100] },
              2,
            ],
          },
          else: 0,
        },
      },
      price_tier: {
        $switch: {
          branches: [
            { case: { $lte: ["$price_numeric", 50] }, then: "budget" },
            { case: { $lte: ["$price_numeric", 150] }, then: "mid-range" },
            { case: { $lte: ["$price_numeric", 300] }, then: "premium" },
          ],
          default: "luxury",
        },
      },
    },
  },

  // Stage 6 (slow): $group — aggregate by country, property_type, price_tier
  {
    $group: {
      _id: {
        country: "$country",
        property_type: "$property_type",
        price_tier: "$price_tier",
      },
      avg_price: { $avg: "$price_numeric" },
      avg_total_cost: { $avg: "$total_cost" },
      avg_rating: { $avg: "$review_scores_rating" },
      avg_value_score: { $avg: "$value_score" },
      avg_comment_length: { $avg: "$avg_comment_length" },
      avg_amenities: { $avg: "$amenity_count" },
      avg_host_portfolio: { $avg: "$host_portfolio_size" },
      superhost_count: { $sum: { $cond: ["$host_is_superhost", 1, 0] } },
      total_listings: { $sum: 1 },
      total_reviews: { $sum: "$number_of_reviews" },
      max_accommodates: { $max: "$accommodates" },
    },
  },

  // Stage 7 (fast): $addFields — derived group metrics
  {
    $addFields: {
      superhost_ratio: {
        $round: [{ $divide: ["$superhost_count", { $max: ["$total_listings", 1] }] }, 2],
      },
      reviews_per_listing: {
        $round: [{ $divide: ["$total_reviews", { $max: ["$total_listings", 1] }] }, 1],
      },
    },
  },

  // Stage 8 (fast): $project — flatten _id and shape final output
  {
    $project: {
      _id: 0,
      country: "$_id.country",
      property_type: "$_id.property_type",
      price_tier: "$_id.price_tier",
      total_listings: 1,
      avg_price: { $round: ["$avg_price", 2] },
      avg_total_cost: { $round: ["$avg_total_cost", 2] },
      avg_rating: { $round: ["$avg_rating", 1] },
      avg_value_score: { $round: ["$avg_value_score", 2] },
      avg_amenities: { $round: ["$avg_amenities", 1] },
      avg_host_portfolio: { $round: ["$avg_host_portfolio", 1] },
      superhost_ratio: 1,
      reviews_per_listing: 1,
      max_accommodates: 1,
    },
  },

  // Stage 9 (medium): $sort — by total listings descending
  { $sort: { total_listings: -1, avg_value_score: -1 } },

  // Stage 10 (fast): $limit — top 50 segments
  { $limit: 50 },
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

    console.log("Running 10-stage aggregation on listingsAndReviews_big (55k docs)…\n");
    const start = Date.now();

    const results = await db
      .collection("listingsAndReviews_big")
      .aggregate(pipeline, { allowDiskUse: true, comment: COMMENT })
      .toArray();

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Completed in ${elapsed}s — ${results.length} result segments\n`);

    console.log("Top 10 segments by listing count:");
    console.log("─".repeat(120));
    console.log(
      "Country".padEnd(20),
      "Type".padEnd(18),
      "Tier".padEnd(10),
      "#Listings".padStart(9),
      "AvgPrice".padStart(9),
      "AvgRating".padStart(10),
      "ValueScore".padStart(11),
      "SuperHost%".padStart(11),
      "Rev/List".padStart(9),
    );
    console.log("─".repeat(120));

    for (const r of results.slice(0, 10)) {
      console.log(
        (r.country || "?").padEnd(20),
        (r.property_type || "?").padEnd(18),
        (r.price_tier || "?").padEnd(10),
        String(r.total_listings).padStart(9),
        String(r.avg_price).padStart(9),
        String(r.avg_rating).padStart(10),
        String(r.avg_value_score).padStart(11),
        String(r.superhost_ratio).padStart(11),
        String(r.reviews_per_listing).padStart(9),
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
