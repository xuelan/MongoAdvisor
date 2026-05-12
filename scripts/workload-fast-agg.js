require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");
const { resolveWorkloadMongoUri } = require("./workload-uri");

/**
 * Fast, index-backed AGGREGATION workload.
 *
 * Companion to scripts/workload-mflix-fast.js (which does pure finds). Every
 * pipeline here is designed to:
 *
 *   1. Filter through an index on the first $match stage (no COLLSCAN).
 *   2. Funnel a few hundred to a few thousand docs into $group / $bucket so
 *      the steady-state latency lands in the 100ms – 1 s window — fast enough
 *      to drive `queryStats` cardinality, slow enough to be visible in the
 *      Slow Query feed and Performance Advisor.
 *   3. Use a unique `appName` and a `comment` per template so each shape is
 *      distinguishable in MongoAdvisor and Atlas Query Insights.
 *
 * Targets:
 *   sample_airbnb.listingsAndReviews_big   (built by airbnb-expand-listings-big.js)
 *   sample_mflix.embedded_movies, movies
 *
 * Required indexes
 *   On first run, this worker creates the airbnb indexes it depends on (they
 *   are missing from the `_big` collection by default). The createIndex calls
 *   are idempotent — instant no-op on subsequent runs.
 *
 * Environment
 *   DURATION_MS       worker run length          (default 5 min)
 *   MIN_SLEEP_MS      sleep between ops, min     (default 100)
 *   MAX_SLEEP_MS      sleep between ops, max     (default 400)
 *   MAX_TIME_MS       per-aggregation cap        (default 8000)
 *   READ_PREF         primary | secondary        (default random)
 *   WORKLOAD_MONGO_URI / MONGO_URI
 */

const AIRBNB_DB = "sample_airbnb";
const AIRBNB_COLL = "listingsAndReviews_big";
const MFLIX_DB = "sample_mflix";
const MFLIX_MOVIES = "embedded_movies";

const DURATION_MS = parseInt(process.env.DURATION_MS || `${5 * 60 * 1000}`, 10);
const MIN_SLEEP_MS = parseInt(process.env.MIN_SLEEP_MS || "100", 10);
const MAX_SLEEP_MS = parseInt(process.env.MAX_SLEEP_MS || "400", 10);
const MAX_TIME_MS = parseInt(process.env.MAX_TIME_MS || "8000", 10);

const baseUri = resolveWorkloadMongoUri();
if (!baseUri) {
  console.error("Set MONGO_URI or WORKLOAD_MONGO_URI in .env");
  process.exit(1);
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = new Set();
  while (out.size < n) out.add(pick(arr));
  return [...out];
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);

function mongoUriFor(appName) {
  const q = new URLSearchParams({ appName, readPreference: readPref });
  return baseUri + (baseUri.includes("?") ? "&" : "?") + q.toString();
}

// ── seeds ────────────────────────────────────────────────────────────────────

const FALLBACK_GENRES = [
  "Drama", "Comedy", "Action", "Romance", "Thriller", "Horror",
  "Crime", "Adventure", "Science Fiction", "Animation", "Documentary", "Fantasy",
];
const FALLBACK_RATED = ["G", "PG", "PG-13", "R", "NOT RATED", "UNRATED"];

async function sampleAirbnbSeeds(db) {
  const coll = db.collection(AIRBNB_COLL);
  const exists = (await db.listCollections({ name: AIRBNB_COLL }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return null;

  // Sample directly instead of distinct() — distinct on 16M+ doc collections
  // can be slow and burn memory. $sample uses a random cursor; cheap.
  const sample = await coll.aggregate(
    [
      { $sample: { size: 400 } },
      {
        $project: {
          _id: 0,
          country: "$address.country",
          market: "$address.market",
          property_type: 1,
          host_id: "$host.host_id",
        },
      },
    ],
    { comment: "workload-fast-agg-seed", maxTimeMS: 10_000 },
  ).toArray();

  const countries = Array.from(new Set(sample.map((d) => d.country).filter(Boolean))).slice(0, 25);
  const markets = Array.from(new Set(sample.map((d) => d.market).filter(Boolean))).slice(0, 25);
  const propertyTypes = Array.from(new Set(sample.map((d) => d.property_type).filter(Boolean))).slice(0, 15);
  const hostIds = Array.from(new Set(sample.map((d) => d.host_id).filter(Boolean))).slice(0, 80);

  return { countries, markets, propertyTypes, hostIds };
}

async function sampleMflixSeeds(db) {
  const coll = db.collection(MFLIX_MOVIES);
  const exists = (await db.listCollections({ name: MFLIX_MOVIES }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return null;

  const sample = await coll.find(
    { cast: { $exists: true, $ne: [] } },
    { projection: { cast: 1, genres: 1, rated: 1, _id: 0 } },
  ).limit(150).toArray();

  const cast = Array.from(
    new Set(sample.flatMap((d) => (d.cast || []).slice(0, 2))),
  ).slice(0, 60);
  const genres = Array.from(new Set(sample.flatMap((d) => d.genres || [])));
  const rated = Array.from(new Set(sample.map((d) => d.rated).filter(Boolean)));

  return {
    cast,
    genres: genres.length ? genres : FALLBACK_GENRES,
    rated: rated.length ? rated : FALLBACK_RATED,
  };
}

// ── index bootstrap ─────────────────────────────────────────────────────────

const AIRBNB_REQUIRED_INDEXES = [
  { keys: { "address.country": 1 },                   name: "workload_address_country" },
  { keys: { "address.market": 1 },                    name: "workload_address_market" },
  { keys: { "host.host_id": 1 },                      name: "workload_host_host_id" },
  { keys: { property_type: 1, bedrooms: 1 },          name: "workload_property_type_bedrooms" },
  { keys: { "address.country": 1, last_review: -1 },  name: "workload_country_last_review" },
  { keys: { "address.country": 1, number_of_reviews: -1 }, name: "workload_country_reviews" },
];

async function ensureAirbnbIndexes(db) {
  const coll = db.collection(AIRBNB_COLL);
  const existingNames = new Set((await coll.indexes()).map((i) => i.name));
  const created = [];
  for (const ix of AIRBNB_REQUIRED_INDEXES) {
    if (existingNames.has(ix.name)) continue;
    const t0 = Date.now();
    try {
      await coll.createIndex(ix.keys, { name: ix.name, background: true });
      created.push(`${ix.name} (${Date.now() - t0}ms)`);
    } catch (err) {
      console.warn(`  index ${ix.name}: ${err.message}`);
    }
  }
  if (created.length) console.log(`Created airbnb workload indexes: ${created.join(", ")}`);
  else console.log("Airbnb workload indexes already present");
}

// ── pipeline templates ──────────────────────────────────────────────────────

function buildAirbnbTemplates(seeds) {
  // Avoid bias toward very-populous countries (USA, Brazil) — they pull too
  // many docs through $group and push p95 above 1 s. Mix small + large
  // countries so the worker stays in the 100ms–1s envelope.
  return [
    {
      key: "airbnb_country_property_breakdown",
      appName: "workload-fast-agg-airbnb-country-property",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => ({
        pipeline: [
          { $match: { "address.country": pick(seeds.countries) } },
          {
            $group: {
              _id: "$property_type",
              count: { $sum: 1 },
              avgReviews: { $avg: "$number_of_reviews" },
              avgBedrooms: { $avg: "$bedrooms" },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ],
      }),
    },
    {
      key: "airbnb_market_room_breakdown",
      appName: "workload-fast-agg-airbnb-market-room",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => ({
        pipeline: [
          { $match: { "address.market": pick(seeds.markets) } },
          {
            $group: {
              _id: "$room_type",
              count: { $sum: 1 },
              avgAccommodates: { $avg: "$accommodates" },
              avgReviewScore: { $avg: "$review_scores.review_scores_rating" },
            },
          },
          { $sort: { count: -1 } },
        ],
      }),
    },
    {
      key: "airbnb_host_portfolio",
      appName: "workload-fast-agg-airbnb-host-portfolio",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => ({
        pipeline: [
          { $match: { "host.host_id": pick(seeds.hostIds) } },
          {
            $project: {
              name: 1,
              property_type: 1,
              room_type: 1,
              price: 1,
              number_of_reviews: 1,
              "address.country": 1,
              "address.market": 1,
              _id: 0,
            },
          },
          { $limit: 50 },
        ],
      }),
    },
    {
      key: "airbnb_popular_by_country",
      appName: "workload-fast-agg-airbnb-popular-country",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => ({
        pipeline: [
          {
            $match: {
              "address.country": pick(seeds.countries),
              number_of_reviews: { $gte: rand(20, 60) },
            },
          },
          { $sort: { number_of_reviews: -1 } },
          { $limit: rand(15, 25) },
          {
            $project: {
              name: 1,
              property_type: 1,
              room_type: 1,
              number_of_reviews: 1,
              "review_scores.review_scores_rating": 1,
              "address.market": 1,
              _id: 0,
            },
          },
        ],
      }),
    },
    {
      key: "airbnb_recent_reviews_by_country",
      appName: "workload-fast-agg-airbnb-recent-reviews",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => {
        const yearsAgo = rand(2, 6);
        const since = new Date();
        since.setFullYear(since.getFullYear() - yearsAgo);
        return {
          pipeline: [
            {
              $match: {
                "address.country": pick(seeds.countries),
                last_review: { $gte: since },
              },
            },
            {
              $group: {
                _id: { year: { $year: "$last_review" }, month: { $month: "$last_review" } },
                listings: { $sum: 1 },
                avgReviews: { $avg: "$number_of_reviews" },
              },
            },
            { $sort: { "_id.year": -1, "_id.month": -1 } },
            { $limit: 24 },
          ],
        };
      },
    },
    {
      key: "airbnb_property_bedrooms",
      appName: "workload-fast-agg-airbnb-property-bedrooms",
      db: AIRBNB_DB,
      coll: AIRBNB_COLL,
      build: () => ({
        pipeline: [
          {
            $match: {
              property_type: pick(seeds.propertyTypes),
              bedrooms: { $gte: 1, $lte: 6 },
            },
          },
          {
            $group: {
              _id: "$bedrooms",
              count: { $sum: 1 },
              avgReviewScore: { $avg: "$review_scores.review_scores_rating" },
              avgReviews: { $avg: "$number_of_reviews" },
            },
          },
          { $sort: { _id: 1 } },
        ],
      }),
    },
  ];
}

function buildMflixTemplates(seeds) {
  return [
    {
      key: "mflix_genre_year_count",
      appName: "workload-fast-agg-mflix-genre-year",
      db: MFLIX_DB,
      coll: MFLIX_MOVIES,
      build: () => ({
        pipeline: [
          { $match: { genres: pick(seeds.genres) } },
          {
            $group: {
              _id: "$year",
              movies: { $sum: 1 },
              avgRating: { $avg: "$imdb.rating" },
              avgRuntime: { $avg: "$runtime" },
            },
          },
          { $match: { _id: { $type: "number" } } },
          { $sort: { _id: -1 } },
          { $limit: 30 },
        ],
      }),
    },
    {
      key: "mflix_top_cast_by_rated",
      appName: "workload-fast-agg-mflix-cast-rated",
      db: MFLIX_DB,
      coll: MFLIX_MOVIES,
      build: () => ({
        pipeline: [
          { $match: { rated: pick(seeds.rated) } },
          { $unwind: "$cast" },
          {
            $group: {
              _id: "$cast",
              movies: { $sum: 1 },
              avgRating: { $avg: "$imdb.rating" },
            },
          },
          { $match: { movies: { $gte: 3 } } },
          { $sort: { movies: -1 } },
          { $limit: 20 },
        ],
      }),
    },
    {
      key: "mflix_runtime_buckets",
      appName: "workload-fast-agg-mflix-runtime-buckets",
      db: MFLIX_DB,
      coll: MFLIX_MOVIES,
      build: () => {
        const lo = rand(60, 90);
        const hi = lo + rand(60, 120);
        return {
          pipeline: [
            { $match: { runtime: { $gte: lo, $lte: hi } } },
            {
              $bucket: {
                groupBy: "$runtime",
                boundaries: [0, 60, 90, 120, 150, 180, 240, 480],
                default: "other",
                output: {
                  count: { $sum: 1 },
                  avgRating: { $avg: "$imdb.rating" },
                },
              },
            },
          ],
        };
      },
    },
    {
      key: "mflix_coactors_in_cast",
      appName: "workload-fast-agg-mflix-coactors",
      db: MFLIX_DB,
      coll: MFLIX_MOVIES,
      build: () => {
        const actor = pick(seeds.cast);
        return {
          pipeline: [
            { $match: { cast: actor } },
            { $project: { cast: 1, "imdb.rating": 1, _id: 0 } },
            { $unwind: "$cast" },
            { $match: { cast: { $ne: actor } } },
            {
              $group: {
                _id: "$cast",
                coappearances: { $sum: 1 },
                avgRating: { $avg: "$imdb.rating" },
              },
            },
            { $sort: { coappearances: -1 } },
            { $limit: 15 },
          ],
        };
      },
    },
  ];
}

// ── run loop ────────────────────────────────────────────────────────────────

async function runOne(clientsByApp, tmpl) {
  const client = clientsByApp.get(tmpl.appName);
  const db = client.db(tmpl.db);
  const { pipeline } = tmpl.build();
  const t0 = Date.now();
  const docs = await db.collection(tmpl.coll).aggregate(pipeline, {
    comment: tmpl.key,
    maxTimeMS: MAX_TIME_MS,
    allowDiskUse: true,
  }).toArray();
  return { ms: Date.now() - t0, n: docs.length };
}

async function main() {
  // 1. seed client (short-lived; used for index bootstrap + sampling seeds)
  const seedClient = new MongoClient(mongoUriFor("workload-fast-agg-seed"), {
    maxPoolSize: 3,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });
  await seedClient.connect();

  let airbnbSeeds = null;
  let mflixSeeds = null;
  try {
    const airbnbDb = seedClient.db(AIRBNB_DB);
    const mflixDb = seedClient.db(MFLIX_DB);

    // Sample seeds first — cheap; reveals which DBs are usable.
    [airbnbSeeds, mflixSeeds] = await Promise.all([
      sampleAirbnbSeeds(airbnbDb),
      sampleMflixSeeds(mflixDb),
    ]);

    if (airbnbSeeds) {
      console.log(`Airbnb seeds: ${airbnbSeeds.countries.length} countries, ${airbnbSeeds.markets.length} markets, ${airbnbSeeds.propertyTypes.length} property types, ${airbnbSeeds.hostIds.length} host ids`);
      await ensureAirbnbIndexes(airbnbDb);
    } else {
      console.log(`Skipping airbnb pipelines — ${AIRBNB_DB}.${AIRBNB_COLL} not found (run scripts/airbnb-expand-listings-big.js first)`);
    }
    if (mflixSeeds) {
      console.log(`Mflix seeds: ${mflixSeeds.cast.length} cast, ${mflixSeeds.genres.length} genres, ${mflixSeeds.rated.length} rated`);
    } else {
      console.log(`Skipping mflix pipelines — ${MFLIX_DB}.${MFLIX_MOVIES} not found (load the sample data set)`);
    }
  } finally {
    await seedClient.close();
  }

  // 2. assemble templates from whatever datasets are available
  const templates = [];
  if (airbnbSeeds && airbnbSeeds.countries.length && airbnbSeeds.hostIds.length) {
    templates.push(...buildAirbnbTemplates(airbnbSeeds));
  }
  if (mflixSeeds && mflixSeeds.cast.length) {
    templates.push(...buildMflixTemplates(mflixSeeds));
  }

  if (templates.length === 0) {
    console.error("No usable aggregation templates — neither sample_airbnb.listingsAndReviews_big nor sample_mflix.embedded_movies were reachable");
    process.exit(1);
  }
  console.log(`Templates: ${templates.map((t) => t.key).join(", ")}`);
  console.log(`Running for ${(DURATION_MS / 1000).toFixed(0)}s  (read preference: ${readPref})\n`);

  // 3. per-template clients (each gets a unique appName)
  const clientsByApp = new Map();
  for (const t of templates) {
    const c = new MongoClient(mongoUriFor(t.appName), {
      maxPoolSize: 3,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
    });
    await c.connect();
    clientsByApp.set(t.appName, c);
  }

  const stats = new Map();
  for (const t of templates) stats.set(t.key, { runs: 0, errors: 0, totalMs: 0, totalResults: 0 });

  // 4. loop
  const end = Date.now() + DURATION_MS;
  const startWall = Date.now();
  try {
    while (Date.now() < end) {
      const t = pick(templates);
      try {
        const { ms, n } = await runOne(clientsByApp, t);
        const s = stats.get(t.key);
        s.runs += 1;
        s.totalMs += ms;
        s.totalResults += n;
        if (s.runs % 10 === 0) {
          const elapsed = ((Date.now() - startWall) / 1000).toFixed(0);
          console.log(`  [${elapsed}s] ${t.key.padEnd(36)} run ${s.runs}  ${ms}ms  ${n} docs`);
        }
      } catch (err) {
        const s = stats.get(t.key);
        s.errors += 1;
        console.error(`  ! ${t.key}: ${err.message}`);
      }
      await sleep(rand(MIN_SLEEP_MS, MAX_SLEEP_MS));
    }
  } finally {
    for (const c of clientsByApp.values()) await c.close();
  }

  // 5. summary in the same format as workload-mflix-fast.js so the
  //    orchestrator can roll up `Total queries:` lines uniformly.
  const totalElapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(80)}`);
  console.log(`Done in ${totalElapsed}s\n`);
  console.log(`  ${"template".padEnd(36)} ${"runs".padStart(6)}  ${"errs".padStart(4)}  ${"avg ms".padStart(7)}  ${"avg docs".padStart(8)}`);
  console.log(`  ${"─".repeat(36)} ${"─".repeat(6)}  ${"─".repeat(4)}  ${"─".repeat(7)}  ${"─".repeat(8)}`);
  let totalRuns = 0;
  for (const [key, s] of stats) {
    totalRuns += s.runs;
    const avgMs = s.runs ? (s.totalMs / s.runs).toFixed(1) : "–";
    const avgN = s.runs ? (s.totalResults / s.runs).toFixed(1) : "–";
    console.log(`  ${key.padEnd(36)} ${String(s.runs).padStart(6)}  ${String(s.errors).padStart(4)}  ${String(avgMs).padStart(7)}  ${String(avgN).padStart(8)}`);
  }
  console.log(`\nTotal queries: ${totalRuns}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

// Silence "pickN unused" lints if templates are trimmed.
void pickN;
