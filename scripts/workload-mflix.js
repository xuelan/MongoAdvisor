require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME = "workload-mflix";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const uri = baseUri + (baseUri.includes("?") ? "&" : "?") + `appName=${APP_NAME}`;

// ─── Pipeline 1: Actor collaboration network ────────────────────────────────
const COMMENT_1 = "Mflix actor-collab: unwind cast, self-lookup co-stars, group pair frequency, rank top duos";

const pipeline1 = [
  { $match: { cast: { $exists: true }, "imdb.rating": { $gt: 0 } } },
  { $unwind: "$cast" },
  {
    $lookup: {
      from: "embedded_movies",
      localField: "cast",
      foreignField: "cast",
      as: "shared_movies",
    },
  },
  {
    $addFields: {
      co_stars: {
        $reduce: {
          input: "$shared_movies",
          initialValue: [],
          in: { $setUnion: ["$$value", "$$this.cast"] },
        },
      },
      actor_movie_count: { $size: "$shared_movies" },
      avg_shared_rating: { $avg: "$shared_movies.imdb.rating" },
    },
  },
  {
    $addFields: {
      co_star_count: { $size: "$co_stars" },
      top_co_stars: {
        $slice: [
          { $filter: { input: "$co_stars", as: "c", cond: { $ne: ["$$c", "$cast"] } } },
          5,
        ],
      },
    },
  },
  { $project: { shared_movies: 0, co_stars: 0 } },
  {
    $group: {
      _id: "$cast",
      appearances: { $sum: 1 },
      avg_movie_rating: { $avg: "$avg_shared_rating" },
      total_co_stars: { $max: "$co_star_count" },
      total_movies_in_network: { $max: "$actor_movie_count" },
      genres_acted: { $addToSet: "$genres" },
    },
  },
  {
    $addFields: {
      network_score: {
        $round: [
          { $multiply: [
            { $ln: { $max: ["$total_co_stars", 1] } },
            { $ifNull: ["$avg_movie_rating", 1] },
          ]},
          2,
        ],
      },
    },
  },
  { $sort: { network_score: -1 } },
  { $limit: 20 },
];

// ─── Pipeline 2: Genre evolution by decade ───────────────────────────────────
const COMMENT_2 = "Mflix genre-evolution: unwind genres+countries, bucket decades, double group, compute trend deltas";

const pipeline2 = [
  { $match: { year: { $gte: 1950, $lte: 2020 }, genres: { $exists: true }, "imdb.votes": { $gte: 100 } } },
  { $unwind: "$genres" },
  { $unwind: "$countries" },
  {
    $addFields: {
      decade: { $multiply: [{ $floor: { $divide: ["$year", 10] } }, 10] },
      runtime_bucket: {
        $switch: {
          branches: [
            { case: { $lte: ["$runtime", 90] }, then: "short" },
            { case: { $lte: ["$runtime", 120] }, then: "standard" },
            { case: { $lte: ["$runtime", 180] }, then: "long" },
          ],
          default: "epic",
        },
      },
      critic_viewer_gap: {
        $subtract: [
          { $ifNull: ["$tomatoes.critic.rating", 0] },
          { $ifNull: ["$tomatoes.viewer.rating", 0] },
        ],
      },
      plot_length: { $strLenCP: { $ifNull: ["$fullplot", ""] } },
      award_total: { $add: [{ $ifNull: ["$awards.wins", 0] }, { $ifNull: ["$awards.nominations", 0] }] },
    },
  },
  {
    $group: {
      _id: { decade: "$decade", genre: "$genres", country: "$countries" },
      movie_count: { $sum: 1 },
      avg_rating: { $avg: "$imdb.rating" },
      avg_votes: { $avg: "$imdb.votes" },
      avg_runtime: { $avg: "$runtime" },
      avg_critic_gap: { $avg: "$critic_viewer_gap" },
      avg_plot_length: { $avg: "$plot_length" },
      avg_awards: { $avg: "$award_total" },
      top_rated: { $max: "$imdb.rating" },
      runtime_buckets: { $push: "$runtime_bucket" },
    },
  },
  {
    $addFields: {
      short_pct: {
        $round: [{
          $multiply: [
            { $divide: [
              { $size: { $filter: { input: "$runtime_buckets", as: "b", cond: { $eq: ["$$b", "short"] } } } },
              { $max: [{ $size: "$runtime_buckets" }, 1] },
            ]},
            100,
          ],
        }, 1],
      },
    },
  },
  { $project: { runtime_buckets: 0 } },
  {
    $group: {
      _id: { decade: "$_id.decade", genre: "$_id.genre" },
      countries: { $sum: 1 },
      total_movies: { $sum: "$movie_count" },
      avg_rating: { $avg: "$avg_rating" },
      avg_votes: { $avg: "$avg_votes" },
      avg_runtime: { $avg: "$avg_runtime" },
      avg_awards: { $avg: "$avg_awards" },
      avg_critic_gap: { $avg: "$avg_critic_gap" },
      avg_short_pct: { $avg: "$short_pct" },
    },
  },
  {
    $project: {
      _id: 0,
      decade: "$_id.decade",
      genre: "$_id.genre",
      countries: 1,
      total_movies: 1,
      avg_rating: { $round: ["$avg_rating", 1] },
      avg_votes: { $round: ["$avg_votes", 0] },
      avg_runtime: { $round: ["$avg_runtime", 0] },
      avg_awards: { $round: ["$avg_awards", 1] },
      avg_critic_gap: { $round: ["$avg_critic_gap", 2] },
      avg_short_pct: { $round: ["$avg_short_pct", 1] },
    },
  },
  { $sort: { total_movies: -1 } },
  { $limit: 30 },
];

// ─── Pipeline 3: Director career analysis with writer overlap ────────────────
const COMMENT_3 = "Mflix director-career: unwind directors, lookup writer overlap, facet career phases, rank by longevity";

const pipeline3 = [
  { $match: { directors: { $exists: true }, year: { $exists: true }, "imdb.rating": { $gt: 0 } } },
  { $unwind: "$directors" },
  {
    $lookup: {
      from: "embedded_movies",
      localField: "directors",
      foreignField: "writers",
      as: "also_wrote",
    },
  },
  {
    $addFields: {
      is_writer_director: { $gt: [{ $size: "$also_wrote" }, 0] },
      writing_credits: { $size: "$also_wrote" },
      genre_list: { $ifNull: ["$genres", []] },
      cast_size: { $size: { $ifNull: ["$cast", []] } },
      has_tomatoes: { $gt: [{ $ifNull: ["$tomatoes.viewer.rating", 0] }, 0] },
      viewer_rating: { $ifNull: ["$tomatoes.viewer.rating", null] },
      critic_rating: { $ifNull: ["$tomatoes.critic.rating", null] },
    },
  },
  { $project: { also_wrote: 0 } },
  {
    $group: {
      _id: "$directors",
      film_count: { $sum: 1 },
      career_start: { $min: "$year" },
      career_end: { $max: "$year" },
      avg_imdb: { $avg: "$imdb.rating" },
      total_votes: { $sum: "$imdb.votes" },
      avg_viewer: { $avg: "$viewer_rating" },
      avg_critic: { $avg: "$critic_rating" },
      avg_runtime: { $avg: "$runtime" },
      avg_cast_size: { $avg: "$cast_size" },
      total_awards: { $sum: { $add: [{ $ifNull: ["$awards.wins", 0] }, { $ifNull: ["$awards.nominations", 0] }] } },
      is_writer_director: { $max: "$is_writer_director" },
      writing_credits: { $max: "$writing_credits" },
      all_genres: { $push: "$genre_list" },
    },
  },
  {
    $addFields: {
      career_span: { $subtract: ["$career_end", "$career_start"] },
      unique_genres: {
        $size: {
          $reduce: {
            input: "$all_genres",
            initialValue: [],
            in: { $setUnion: ["$$value", "$$this"] },
          },
        },
      },
      productivity: {
        $round: [
          { $cond: {
            if: { $gt: [{ $subtract: ["$career_end", "$career_start"] }, 0] },
            then: { $divide: ["$film_count", { $subtract: ["$career_end", "$career_start"] }] },
            else: "$film_count",
          }},
          2,
        ],
      },
    },
  },
  {
    $match: { film_count: { $gte: 3 } },
  },
  {
    $project: {
      _id: 0,
      director: "$_id",
      film_count: 1,
      career_span: 1,
      career_start: 1,
      career_end: 1,
      avg_imdb: { $round: ["$avg_imdb", 1] },
      total_votes: 1,
      avg_runtime: { $round: ["$avg_runtime", 0] },
      total_awards: 1,
      unique_genres: 1,
      is_writer_director: 1,
      productivity: 1,
    },
  },
  { $sort: { total_votes: -1 } },
  { $limit: 25 },
];

const pipelines = [
  { name: "Actor Collaboration Network", pipeline: pipeline1, comment: COMMENT_1 },
  { name: "Genre Evolution by Decade", pipeline: pipeline2, comment: COMMENT_2 },
  { name: "Director Career Analysis", pipeline: pipeline3, comment: COMMENT_3 },
];

async function main() {
  const selected = process.argv[2] ? parseInt(process.argv[2]) : null;

  const client = new MongoClient(uri, {
    maxPoolSize: 3,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    await client.connect();
    const db = client.db("sample_mflix");

    const toRun = selected
      ? [pipelines[selected - 1]]
      : pipelines;

    for (const { name, pipeline, comment } of toRun) {
      console.log(`\n▶ ${name}`);
      console.log(`  comment: ${comment}\n`);

      const start = Date.now();
      const results = await db
        .collection("embedded_movies")
        .aggregate(pipeline, { allowDiskUse: true, comment })
        .toArray();
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);

      console.log(`  Completed in ${elapsed}s — ${results.length} results`);
      console.log(`  Sample:`, JSON.stringify(results[0], null, 2).slice(0, 300), "…\n");
    }
  } finally {
    await client.close();
    console.log("Connection closed");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
