require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME = "workload-mflix";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);
const uri = baseUri + (baseUri.includes("?") ? "&" : "?") + `appName=${APP_NAME}&readPreference=${readPref}`;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Pipeline 1: Actor collaboration network ────────────────────────────────
const COMMENT_1 = "Mflix actor-collab: unwind cast, self-lookup co-stars, group pair frequency, rank top duos";

const minRating1 = rand(0, 5);
const limitP1 = rand(10, 30);
const pipeline1 = [
  { $match: { cast: { $exists: true }, "imdb.rating": { $gt: minRating1 } } },
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
  { $limit: limitP1 },
];

// ─── Pipeline 2: Genre evolution by decade ───────────────────────────────────
const COMMENT_2 = "Mflix genre-evolution: unwind genres+countries, bucket decades, double group, compute trend deltas";

const startYear = rand(1930, 1970);
const endYear = rand(2000, 2020);
const minVotes = rand(50, 500);
const limitP2 = rand(15, 50);
const pipeline2 = [
  { $match: { year: { $gte: startYear, $lte: endYear }, genres: { $exists: true }, "imdb.votes": { $gte: minVotes } } },
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
  { $sort: { [pick(["total_movies", "avg_rating", "avg_votes"])]: -1 } },
  { $limit: limitP2 },
];

// ─── Pipeline 3: Director career analysis with writer overlap ────────────────
const COMMENT_3 = "Mflix director-career: unwind directors, lookup writer overlap, facet career phases, rank by longevity";

const minRating3 = rand(0, 4);
const minFilms = rand(2, 5);
const limitP3 = rand(10, 40);
const sortP3 = pick(["total_votes", "film_count", "career_span", "avg_imdb"]);
const pipeline3 = [
  { $match: { directors: { $exists: true }, year: { $exists: true }, "imdb.rating": { $gt: minRating3 } } },
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
    $match: { film_count: { $gte: minFilms } },
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
  { $sort: { [sortP3]: -1 } },
  { $limit: limitP3 },
];

// ─── Pipeline 4: Award-winning cast overlap across genres ─────────────────────
const COMMENT_4 = "Mflix award-cast-overlap: match awarded, unwind cast+genres, self-lookup shared films, group cross-genre stats";

const minWins4 = rand(1, 5);
const limitP4 = rand(10, 30);
const pipeline4 = [
  { $match: { "awards.wins": { $gte: minWins4 }, cast: { $exists: true }, genres: { $exists: true } } },
  { $unwind: "$cast" },
  { $unwind: "$genres" },
  {
    $lookup: {
      from: "embedded_movies",
      let: { actor: "$cast", genre: "$genres" },
      pipeline: [
        { $match: { $expr: { $and: [{ $in: ["$$actor", { $ifNull: ["$cast", []] }] }, { $not: { $in: ["$$genre", { $ifNull: ["$genres", []] }] } } ] } } },
        { $project: { title: 1, year: 1, "imdb.rating": 1 } },
        { $limit: 10 },
      ],
      as: "crossover_films",
    },
  },
  {
    $addFields: {
      crossover_count: { $size: "$crossover_films" },
      avg_crossover_rating: { $avg: "$crossover_films.imdb.rating" },
    },
  },
  { $project: { crossover_films: 0 } },
  {
    $group: {
      _id: { actor: "$cast", genre: "$genres" },
      films_in_genre: { $sum: 1 },
      total_wins: { $sum: "$awards.wins" },
      avg_rating: { $avg: "$imdb.rating" },
      crossover_reach: { $sum: "$crossover_count" },
      avg_crossover_quality: { $avg: "$avg_crossover_rating" },
    },
  },
  {
    $group: {
      _id: "$_id.actor",
      genres_count: { $sum: 1 },
      total_films: { $sum: "$films_in_genre" },
      total_wins: { $sum: "$total_wins" },
      avg_rating: { $avg: "$avg_rating" },
      total_crossover: { $sum: "$crossover_reach" },
      genre_breakdown: {
        $push: { genre: "$_id.genre", count: "$films_in_genre", wins: "$total_wins" },
      },
    },
  },
  {
    $addFields: {
      versatility_score: {
        $round: [{ $multiply: [{ $ln: { $max: ["$genres_count", 1] } }, "$avg_rating"] }, 2],
      },
    },
  },
  { $sort: { versatility_score: -1 } },
  { $limit: limitP4 },
];

// ─── Pipeline 5: Tomatoes critic vs viewer sentiment divergence ───────────────
const COMMENT_5 = "Mflix sentiment-divergence: match rated, compute critic-viewer gap, unwind genres, bucket by gap severity, rank polarizing";

const minVotes5 = rand(100, 1000);
const limitP5 = rand(15, 40);
const pipeline5 = [
  {
    $match: {
      "tomatoes.critic.rating": { $exists: true },
      "tomatoes.viewer.rating": { $exists: true },
      "imdb.votes": { $gte: minVotes5 },
    },
  },
  {
    $addFields: {
      sentiment_gap: { $abs: { $subtract: ["$tomatoes.critic.rating", "$tomatoes.viewer.rating"] } },
      critic_favored: { $gt: ["$tomatoes.critic.rating", "$tomatoes.viewer.rating"] },
      gap_severity: {
        $switch: {
          branches: [
            { case: { $lte: [{ $abs: { $subtract: ["$tomatoes.critic.rating", "$tomatoes.viewer.rating"] } }, 1] }, then: "aligned" },
            { case: { $lte: [{ $abs: { $subtract: ["$tomatoes.critic.rating", "$tomatoes.viewer.rating"] } }, 2.5] }, then: "moderate_split" },
            { case: { $lte: [{ $abs: { $subtract: ["$tomatoes.critic.rating", "$tomatoes.viewer.rating"] } }, 4] }, then: "polarizing" },
          ],
          default: "extreme_divergence",
        },
      },
      plot_word_count: {
        $size: { $split: [{ $ifNull: ["$fullplot", ""] }, " "] },
      },
      has_awards: { $gt: [{ $add: [{ $ifNull: ["$awards.wins", 0] }, { $ifNull: ["$awards.nominations", 0] }] }, 0] },
    },
  },
  { $unwind: "$genres" },
  {
    $group: {
      _id: { genre: "$genres", severity: "$gap_severity" },
      movie_count: { $sum: 1 },
      avg_gap: { $avg: "$sentiment_gap" },
      avg_imdb: { $avg: "$imdb.rating" },
      critic_favored_pct: { $avg: { $cond: ["$critic_favored", 1, 0] } },
      avg_plot_words: { $avg: "$plot_word_count" },
      awarded_pct: { $avg: { $cond: ["$has_awards", 1, 0] } },
      max_gap: { $max: "$sentiment_gap" },
      sample_titles: { $push: { $substr: ["$title", 0, 40] } },
    },
  },
  {
    $addFields: {
      sample_titles: { $slice: ["$sample_titles", 3] },
      critic_favored_pct: { $round: [{ $multiply: ["$critic_favored_pct", 100] }, 1] },
      awarded_pct: { $round: [{ $multiply: ["$awarded_pct", 100] }, 1] },
    },
  },
  { $sort: { avg_gap: -1 } },
  { $limit: limitP5 },
];

// ─── Pipeline 6: Language diversity and international reach ───────────────────
const COMMENT_6 = "Mflix language-reach: unwind languages+countries, lookup same-language films, group polyglot stats, rank global reach";

const minRating6 = rand(3, 7);
const limitP6 = rand(10, 30);
const pipeline6 = [
  { $match: { languages: { $exists: true }, countries: { $exists: true }, "imdb.rating": { $gte: minRating6 } } },
  { $unwind: "$languages" },
  { $unwind: "$countries" },
  {
    $lookup: {
      from: "embedded_movies",
      localField: "languages",
      foreignField: "languages",
      as: "same_lang_films",
    },
  },
  {
    $addFields: {
      lang_pool_size: { $size: "$same_lang_films" },
      avg_lang_pool_rating: { $avg: "$same_lang_films.imdb.rating" },
      lang_pool_decades: {
        $size: {
          $setUnion: {
            $map: {
              input: { $filter: { input: "$same_lang_films", as: "f", cond: { $isNumber: "$$f.year" } } },
              as: "f",
              in: { $multiply: [{ $floor: { $divide: ["$$f.year", 10] } }, 10] },
            },
          },
        },
      },
    },
  },
  { $project: { same_lang_films: 0 } },
  {
    $group: {
      _id: { language: "$languages", country: "$countries" },
      film_count: { $sum: 1 },
      avg_rating: { $avg: "$imdb.rating" },
      avg_pool_size: { $avg: "$lang_pool_size" },
      avg_pool_rating: { $avg: "$avg_lang_pool_rating" },
      decade_spread: { $max: "$lang_pool_decades" },
    },
  },
  {
    $group: {
      _id: "$_id.language",
      countries_produced: { $sum: 1 },
      total_films: { $sum: "$film_count" },
      avg_rating: { $avg: "$avg_rating" },
      avg_pool_size: { $avg: "$avg_pool_size" },
      global_reach_score: {
        $avg: { $multiply: ["$avg_pool_size", "$countries_produced"] },
      },
    },
  },
  {
    $addFields: {
      avg_rating: { $round: ["$avg_rating", 1] },
      global_reach_score: { $round: ["$global_reach_score", 0] },
    },
  },
  { $sort: { [pick(["global_reach_score", "total_films", "countries_produced"])]: -1 } },
  { $limit: limitP6 },
];

// ─── Pipeline 7: Runtime anomaly detection per year ──────────────────────────
const COMMENT_7 = "Mflix runtime-anomaly: compute yearly stats, flag outliers by stddev, self-lookup neighbors, rank extreme deviations";

const minYear7 = rand(1960, 1990);
const maxYear7 = rand(2005, 2020);
const limitP7 = rand(20, 50);
const pipeline7 = [
  { $match: { runtime: { $exists: true, $gt: 0 }, year: { $gte: minYear7, $lte: maxYear7 } } },
  {
    $group: {
      _id: "$year",
      avg_runtime: { $avg: "$runtime" },
      stddev_runtime: { $stdDevPop: "$runtime" },
      min_runtime: { $min: "$runtime" },
      max_runtime: { $max: "$runtime" },
      count: { $sum: 1 },
      movies: {
        $push: {
          title: "$title",
          runtime: "$runtime",
          rating: "$imdb.rating",
          genres: "$genres",
          directors: "$directors",
        },
      },
    },
  },
  { $unwind: "$movies" },
  {
    $addFields: {
      deviation: { $abs: { $subtract: ["$movies.runtime", "$avg_runtime"] } },
      z_score: {
        $cond: {
          if: { $gt: ["$stddev_runtime", 0] },
          then: { $abs: { $divide: [{ $subtract: ["$movies.runtime", "$avg_runtime"] }, "$stddev_runtime"] } },
          else: 0,
        },
      },
      is_anomaly: {
        $cond: {
          if: { $gt: ["$stddev_runtime", 0] },
          then: { $gt: [{ $abs: { $divide: [{ $subtract: ["$movies.runtime", "$avg_runtime"] }, "$stddev_runtime"] } }, 1.5] },
          else: false,
        },
      },
      runtime_pct_of_avg: {
        $round: [{ $multiply: [{ $divide: ["$movies.runtime", { $max: ["$avg_runtime", 1] }] }, 100] }, 1],
      },
    },
  },
  { $match: { is_anomaly: true } },
  {
    $project: {
      _id: 0,
      year: "$_id",
      title: "$movies.title",
      runtime: "$movies.runtime",
      rating: "$movies.rating",
      genres: "$movies.genres",
      directors: "$movies.directors",
      z_score: { $round: ["$z_score", 2] },
      deviation_min: { $round: ["$deviation", 0] },
      year_avg: { $round: ["$avg_runtime", 0] },
      runtime_pct_of_avg: 1,
      year_movie_count: "$count",
    },
  },
  { $sort: { z_score: -1 } },
  { $limit: limitP7 },
];

const pipelines = [
  { name: "Actor Collaboration Network", pipeline: pipeline1, comment: COMMENT_1 },
  { name: "Genre Evolution by Decade", pipeline: pipeline2, comment: COMMENT_2 },
  { name: "Director Career Analysis", pipeline: pipeline3, comment: COMMENT_3 },
  { name: "Award Cast Cross-Genre Overlap", pipeline: pipeline4, comment: COMMENT_4 },
  { name: "Critic vs Viewer Sentiment Divergence", pipeline: pipeline5, comment: COMMENT_5 },
  { name: "Language Diversity & Global Reach", pipeline: pipeline6, comment: COMMENT_6 },
  { name: "Runtime Anomaly Detection", pipeline: pipeline7, comment: COMMENT_7 },
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

    let toRun;
    if (selected) {
      toRun = [pipelines[selected - 1]];
    } else {
      const count = rand(1, pipelines.length);
      const shuffled = [...pipelines].sort(() => Math.random() - 0.5);
      toRun = shuffled.slice(0, count);
    }

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
