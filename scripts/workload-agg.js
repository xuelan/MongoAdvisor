require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME = "workload-a";
const COMMENT = "airbnb_listings_host_lookup_group";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);
const uri = baseUri + (baseUri.includes("?") ? "&" : "?") + `appName=${APP_NAME}&readPreference=${readPref}`;

/** Defaults tuned ~10× lighter than the old ~65s average run; raise via env for stress tests. */
const LISTING_CAP = parseInt(process.env.AIRBNB_DOC_CAP || "80", 10);
const HOST_LOOKUP_CAP = parseInt(process.env.AIRBNB_LOOKUP_CAP || "8", 10);

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const minReviews = rand(3, 15);
const minBedrooms = rand(0, 2);
const reviewSlice = rand(2, 5);
const limitN = rand(8, 18);
const sortField = pick(["total_listings", "avg_value_score", "avg_price", "avg_rating"]);
const priceTiers = [rand(30, 70), rand(100, 200), rand(200, 400)].sort((a, b) => a - b);

// Randomized ISODate range on `last_review` — sample_airbnb reviews span 2010-01 → 2019-03;
// pick a recent-ish lower bound so $queryStats sees varying literals every run.
const LAST_REVIEW_YEAR = rand(2014, 2018);
const LAST_REVIEW_MONTH = rand(1, 12);
const lastReviewGte = new Date(Date.UTC(LAST_REVIEW_YEAR, LAST_REVIEW_MONTH - 1, 1));
const lastReviewLte = new Date(Date.UTC(2019, 2, 31, 23, 59, 59)); // dataset ends 2019-03

const pipeline = [
  // airbnb_match_listings_filters
  {
    $match: {
      number_of_reviews: { $gte: minReviews },
      bedrooms: { $gte: minBedrooms },
      "address.country": { $exists: true },
      last_review: { $gte: lastReviewGte, $lte: lastReviewLte },
    },
  },

  { $limit: LISTING_CAP },

  // Strip bulky fields and pre-slice reviews before per-doc $lookup (large win on listingsAndReviews_big)
  {
    $project: {
      host: 1,
      address: 1,
      price: 1,
      cleaning_fee: 1,
      number_of_reviews: 1,
      amenities: 1,
      bedrooms: 1,
      accommodates: 1,
      room_type: 1,
      property_type: 1,
      name: 1,
      review_scores: 1,
      reviews: { $slice: [{ $ifNull: ["$reviews", []] }, reviewSlice] },
    },
  },

  // airbnb_lookup_same_host
  {
    $lookup: {
      from: "listingsAndReviews",
      let: { hid: "$host.host_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$host.host_id", "$$hid"] } } },
        { $project: { _id: 1, "host.host_id": 1 } },
        { $limit: HOST_LOOKUP_CAP },
      ],
      as: "host_other_listings",
    },
  },

  // airbnb_map_review_slice
  {
    $addFields: {
      review_summary: {
        $map: {
          input: "$reviews",
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

  // airbnb_project_metrics
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

  // airbnb_value_score_tier
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
            { case: { $lte: ["$price_numeric", priceTiers[0]] }, then: "budget" },
            { case: { $lte: ["$price_numeric", priceTiers[1]] }, then: "mid-range" },
            { case: { $lte: ["$price_numeric", priceTiers[2]] }, then: "premium" },
          ],
          default: "luxury",
        },
      },
    },
  },

  // airbnb_group_country_type_tier
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

  // airbnb_group_ratio_fields
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

  // airbnb_project_flatten
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

  // airbnb_sort_limit
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

    console.log(
      `Running 10-stage aggregation (reviews>=${minReviews}, beds>=${minBedrooms}, tiers=${priceTiers}, sort=${sortField}, limit=${limitN}, listingCap=${LISTING_CAP}, hostLookupCap=${HOST_LOOKUP_CAP}, lastReview>=${lastReviewGte.toISOString().slice(0, 10)})…\n`,
    );
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
