require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");
const { resolveWorkloadMongoUri } = require("./workload-uri");

/**
 * Fast, index-backed workload against sample_mflix.
 *
 * Every query template uses an EXISTING index on the target collection:
 *   embedded_movies : cast_1, cast_1_runtime_1, genres_1, rated_1, runtime_1
 *   users           : email_1
 *   sessions        : user_id_1
 *   theaters        : location.geo (2dsphere)
 *   comments        : _id_  (IDHACK)
 *   movies          : cast/fullplot/genres/title text index
 *
 * Loops for DURATION_MS (default 5 min), picking a random template each tick,
 * then sleeps a small jitter between ops.  Per-query appName + comment so the
 * ops show up separately in MongoAdvisor.
 */

const DB_NAME = "sample_mflix";
const DURATION_MS = parseInt(process.env.DURATION_MS || `${5 * 60 * 1000}`, 10);
const MIN_SLEEP_MS = parseInt(process.env.MIN_SLEEP_MS || "80", 10);
const MAX_SLEEP_MS = parseInt(process.env.MAX_SLEEP_MS || "350", 10);
const MAX_TIME_MS = parseInt(process.env.MAX_TIME_MS || "5000", 10);

const baseUri = resolveWorkloadMongoUri();
if (!baseUri) {
  console.error("Set MONGO_URI or WORKLOAD_MONGO_URI in .env");
  process.exit(1);
}
const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);

function mongoUriFor(appName) {
  const q = new URLSearchParams({ appName, readPreference: readPref });
  return baseUri + (baseUri.includes("?") ? "&" : "?") + q.toString();
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const RATED_VALUES = ["G", "PG", "PG-13", "R", "NC-17", "NOT RATED", "UNRATED", "TV-14", "TV-MA"];
const TEXT_KEYWORDS = [
  "love", "war", "family", "murder", "future", "hero", "space", "escape",
  "dream", "secret", "revenge", "journey", "new york", "paris", "london",
];

async function sampleSeeds(client) {
  const db = client.db(DB_NAME);

  const [cast, genres, emails, userIds, theaterNear, commentIds] = await Promise.all([
    db.collection("embedded_movies")
      .find({ cast: { $exists: true, $ne: [] } }, { projection: { cast: 1 } })
      .limit(120).toArray()
      .then((docs) => Array.from(new Set(docs.flatMap((d) => (d.cast || []).slice(0, 2)))).slice(0, 60)),

    db.collection("embedded_movies")
      .find({ genres: { $exists: true, $ne: [] } }, { projection: { genres: 1 } })
      .limit(120).toArray()
      .then((docs) => Array.from(new Set(docs.flatMap((d) => d.genres || []))).slice(0, 25)),

    db.collection("users")
      .find({}, { projection: { email: 1 } })
      .limit(80).toArray()
      .then((docs) => docs.map((d) => d.email).filter(Boolean)),

    db.collection("sessions")
      .find({}, { projection: { user_id: 1 } })
      .limit(80).toArray()
      .then((docs) => docs.map((d) => d.user_id).filter(Boolean)),

    db.collection("theaters")
      .find(
        { "location.geo.coordinates": { $exists: true } },
        { projection: { "location.geo.coordinates": 1 } },
      )
      .limit(40).toArray()
      .then((docs) => docs.map((d) => d.location?.geo?.coordinates).filter((c) => Array.isArray(c) && c.length === 2)),

    db.collection("comments")
      .find({}, { projection: { _id: 1 } })
      .limit(60).toArray()
      .then((docs) => docs.map((d) => d._id)),
  ]);

  return { cast, genres, emails, userIds, theaterNear, commentIds };
}

function buildTemplates(seeds) {
  return [
    {
      key: "mflix_em_cast_eq",
      appName: "workload-mflix-fast-em-cast",
      collection: "embedded_movies",
      build: () => ({
        filter: { cast: pick(seeds.cast) },
        project: { title: 1, year: 1, cast: 1, "imdb.rating": 1, _id: 0 },
        limit: rand(5, 25),
      }),
    },
    {
      key: "mflix_em_cast_runtime",
      appName: "workload-mflix-fast-em-cast-runtime",
      collection: "embedded_movies",
      build: () => ({
        filter: {
          cast: pick(seeds.cast),
          runtime: { $gte: rand(60, 95), $lte: rand(120, 200) },
        },
        project: { title: 1, runtime: 1, year: 1, cast: 1, _id: 0 },
        sort: { runtime: 1 },
        limit: rand(5, 20),
      }),
    },
    {
      key: "mflix_em_genres_eq",
      appName: "workload-mflix-fast-em-genres",
      collection: "embedded_movies",
      build: () => ({
        filter: { genres: pick(seeds.genres) },
        project: { title: 1, genres: 1, year: 1, "imdb.rating": 1, _id: 0 },
        limit: rand(10, 40),
      }),
    },
    {
      key: "mflix_em_rated_eq",
      appName: "workload-mflix-fast-em-rated",
      collection: "embedded_movies",
      build: () => ({
        filter: { rated: pick(RATED_VALUES) },
        project: { title: 1, rated: 1, year: 1, "imdb.rating": 1, _id: 0 },
        limit: rand(10, 35),
      }),
    },
    {
      key: "mflix_em_runtime_range",
      appName: "workload-mflix-fast-em-runtime",
      collection: "embedded_movies",
      build: () => {
        const lo = rand(60, 100);
        return {
          filter: { runtime: { $gte: lo, $lte: lo + rand(10, 40) } },
          project: { title: 1, runtime: 1, year: 1, _id: 0 },
          sort: { runtime: 1 },
          limit: rand(10, 30),
        };
      },
    },
    {
      key: "mflix_users_email_eq",
      appName: "workload-mflix-fast-users-email",
      collection: "users",
      build: () => ({
        filter: { email: pick(seeds.emails) },
        project: { name: 1, email: 1, _id: 0 },
        limit: 1,
      }),
    },
    {
      key: "mflix_sessions_user_eq",
      appName: "workload-mflix-fast-sessions-user",
      collection: "sessions",
      build: () => ({
        filter: { user_id: pick(seeds.userIds) },
        project: { user_id: 1, jwt: 1, _id: 0 },
        limit: 1,
      }),
    },
    {
      key: "mflix_theaters_near",
      appName: "workload-mflix-fast-theaters-near",
      collection: "theaters",
      build: () => {
        const c = pick(seeds.theaterNear);
        return {
          filter: {
            "location.geo": {
              $nearSphere: {
                $geometry: { type: "Point", coordinates: c },
                $maxDistance: rand(20_000, 200_000),
              },
            },
          },
          project: { theaterId: 1, "location.address.city": 1, "location.address.state": 1, _id: 0 },
          limit: rand(5, 20),
        };
      },
    },
    {
      key: "mflix_comments_id_eq",
      appName: "workload-mflix-fast-comments-id",
      collection: "comments",
      build: () => ({
        filter: { _id: pick(seeds.commentIds) },
        project: { name: 1, date: 1, text: 1, _id: 0 },
        limit: 1,
      }),
    },
    {
      key: "mflix_movies_text_search",
      appName: "workload-mflix-fast-movies-text",
      collection: "movies",
      build: () => ({
        filter: { $text: { $search: pick(TEXT_KEYWORDS) } },
        project: { title: 1, year: 1, genres: 1, score: { $meta: "textScore" }, _id: 0 },
        sort: { score: { $meta: "textScore" } },
        limit: rand(5, 20),
      }),
    },
  ];
}

async function runOne(clientsByApp, tmpl) {
  const client = clientsByApp.get(tmpl.appName);
  const db = client.db(DB_NAME);
  const q = tmpl.build();
  const t0 = Date.now();
  let cur = db.collection(tmpl.collection).find(q.filter, {
    comment: tmpl.key,
    maxTimeMS: MAX_TIME_MS,
  });
  if (q.project) cur = cur.project(q.project);
  if (q.sort) cur = cur.sort(q.sort);
  if (q.limit) cur = cur.limit(q.limit);
  const n = (await cur.toArray()).length;
  return { ms: Date.now() - t0, n };
}

async function main() {
  const seedClient = new MongoClient(mongoUriFor("workload-mflix-fast-seed"), {
    maxPoolSize: 3,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });
  await seedClient.connect();

  let seeds;
  try {
    console.log("Sampling seed values from sample_mflix…");
    seeds = await sampleSeeds(seedClient);
  } finally {
    await seedClient.close();
  }

  const templates = buildTemplates(seeds).filter((t) => {
    switch (t.key) {
      case "mflix_em_cast_eq":
      case "mflix_em_cast_runtime":
        return seeds.cast.length > 0;
      case "mflix_em_genres_eq": return seeds.genres.length > 0;
      case "mflix_users_email_eq": return seeds.emails.length > 0;
      case "mflix_sessions_user_eq": return seeds.userIds.length > 0;
      case "mflix_theaters_near": return seeds.theaterNear.length > 0;
      case "mflix_comments_id_eq": return seeds.commentIds.length > 0;
      default: return true;
    }
  });

  if (templates.length === 0) {
    console.error("No usable templates — seeds were empty");
    process.exit(1);
  }

  console.log(`Seeds: ${seeds.cast.length} cast, ${seeds.genres.length} genres, ${seeds.emails.length} emails, ${seeds.userIds.length} user_ids, ${seeds.theaterNear.length} theater coords, ${seeds.commentIds.length} comment ids`);
  console.log(`Templates: ${templates.map((t) => t.key).join(", ")}`);
  console.log(`Running for ${(DURATION_MS / 1000).toFixed(0)}s  (read preference: ${readPref})\n`);

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
        if (s.runs % 25 === 0) {
          const elapsed = ((Date.now() - startWall) / 1000).toFixed(0);
          console.log(`  [${elapsed}s] ${t.key.padEnd(26)} run ${s.runs}  ${ms}ms  ${n} docs`);
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

  const totalElapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(72)}`);
  console.log(`Done in ${totalElapsed}s\n`);
  console.log(`  ${"template".padEnd(26)} ${"runs".padStart(6)}  ${"errs".padStart(4)}  ${"avg ms".padStart(7)}  ${"avg docs".padStart(8)}`);
  console.log(`  ${"─".repeat(26)} ${"─".repeat(6)}  ${"─".repeat(4)}  ${"─".repeat(7)}  ${"─".repeat(8)}`);
  let totalRuns = 0;
  for (const [key, s] of stats) {
    totalRuns += s.runs;
    const avgMs = s.runs ? (s.totalMs / s.runs).toFixed(1) : "–";
    const avgN = s.runs ? (s.totalResults / s.runs).toFixed(1) : "–";
    console.log(`  ${key.padEnd(26)} ${String(s.runs).padStart(6)}  ${String(s.errors).padStart(4)}  ${String(avgMs).padStart(7)}  ${String(avgN).padStart(8)}`);
  }
  console.log(`\nTotal queries: ${totalRuns}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
