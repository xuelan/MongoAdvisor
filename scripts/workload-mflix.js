require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const APP_NAME_AGG = "workload-mflix";

const baseUri = process.env.MONGO_URI;
if (!baseUri) {
  console.error("MONGO_URI is not set in .env");
  process.exit(1);
}
const readPref = process.env.READ_PREF || pick(["primary", "secondary"]);

/** Max docs from embedded_movies after the first $match (before unwinds / lookups). Lower = faster. */
const EMBEDDED_AFTER_MATCH = parseInt(process.env.MFLIX_EMBEDDED_CAP || "400", 10);
/** Max joined docs per $lookup sub-pipeline. */
const LOOKUP_SUB_CAP = parseInt(process.env.MFLIX_LOOKUP_CAP || "45", 10);
/** Max docs before $group in the runtime-outlier pipeline (avoids huge $push arrays). */
const OUTLIER_PRE_GROUP_CAP = parseInt(process.env.MFLIX_OUTLIER_CAP || "1800", 10);

function mongoUriFor(appName) {
  const q = new URLSearchParams({ appName, readPreference: readPref });
  return baseUri + (baseUri.includes("?") ? "&" : "?") + q.toString();
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const copy = [...arr].sort(() => Math.random() - 0.5);
  return copy.slice(0, Math.min(n, copy.length));
}

const MFLIX_GENRES = [
  "Drama", "Comedy", "Action", "Romance", "Thriller", "Horror", "Crime", "Adventure",
  "Science Fiction", "Animation", "Documentary", "Fantasy",
];

// mflix_actor_group_rank
const COMMENT_1 = "mflix_actor_group_rank";

const minRating1 = rand(1, 4);
const limitP1 = rand(8, 22);
const pipeline1 = [
  { $match: { cast: { $exists: true, $ne: [] }, "imdb.rating": { $gt: minRating1 } } },
  { $limit: EMBEDDED_AFTER_MATCH },
  { $unwind: "$cast" },
  {
    $lookup: {
      from: "embedded_movies",
      let: { actor: "$cast" },
      pipeline: [
        { $match: { $expr: { $in: ["$$actor", { $ifNull: ["$cast", []] }] } } },
        { $project: { cast: 1, "imdb.rating": 1, genres: 1 } },
        { $limit: LOOKUP_SUB_CAP },
      ],
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

// mflix_genre_decade_rollups
const COMMENT_2 = "mflix_genre_decade_rollups";

const startYear = rand(1930, 1970);
const endYear = rand(2000, 2020);
const minVotes = rand(80, 400);
const limitP2 = rand(12, 35);
const pipeline2 = [
  { $match: { year: { $gte: startYear, $lte: endYear }, genres: { $exists: true }, "imdb.votes": { $gte: minVotes } } },
  { $limit: Math.min(900, EMBEDDED_AFTER_MATCH * 2) },
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

// mflix_director_writer_overlap
const COMMENT_3 = "mflix_director_writer_overlap";

const minRating3 = rand(1, 4);
const minFilms = rand(2, 4);
const limitP3 = rand(8, 28);
const sortP3 = pick(["total_votes", "film_count", "career_span", "avg_imdb"]);
const pipeline3 = [
  { $match: { directors: { $exists: true }, year: { $exists: true }, "imdb.rating": { $gt: minRating3 } } },
  { $limit: EMBEDDED_AFTER_MATCH },
  { $unwind: "$directors" },
  {
    $lookup: {
      from: "embedded_movies",
      let: { dir: "$directors" },
      pipeline: [
        { $match: { $expr: { $in: ["$$dir", { $ifNull: ["$writers", []] }] } } },
        { $project: { _id: 1 } },
        { $limit: LOOKUP_SUB_CAP },
      ],
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

// mflix_award_cast_crossgenre
const COMMENT_4 = "mflix_award_cast_crossgenre";

const minWins4 = rand(2, 5);
const limitP4 = rand(8, 22);
// Randomized ISODate window on `released` — embedded_movies spans ~1920s-2015.
// Window start between 1960-1995, length 10-30 years, so $queryStats sees varying literals.
const RELEASED_FROM_YEAR_4 = rand(1960, 1995);
const RELEASED_WINDOW_YEARS_4 = rand(10, 30);
const released4Gte = new Date(Date.UTC(RELEASED_FROM_YEAR_4, 0, 1));
const released4Lte = new Date(Date.UTC(RELEASED_FROM_YEAR_4 + RELEASED_WINDOW_YEARS_4, 11, 31, 23, 59, 59));
const pipeline4 = [
  {
    $match: {
      "awards.wins": { $gte: minWins4 },
      cast: { $exists: true },
      genres: { $exists: true },
      released: { $gte: released4Gte, $lte: released4Lte },
    },
  },
  { $limit: EMBEDDED_AFTER_MATCH },
  { $unwind: "$cast" },
  { $unwind: "$genres" },
  {
    $lookup: {
      from: "embedded_movies",
      let: { actor: "$cast", genre: "$genres" },
      pipeline: [
        { $match: { $expr: { $and: [{ $in: ["$$actor", { $ifNull: ["$cast", []] }] }, { $not: { $in: ["$$genre", { $ifNull: ["$genres", []] }] } } ] } } },
        { $project: { title: 1, year: 1, "imdb.rating": 1 } },
        { $limit: 8 },
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

// mflix_tomato_gap_by_genre
const COMMENT_5 = "mflix_tomato_gap_by_genre";

const minVotes5 = rand(200, 900);
const limitP5 = rand(12, 32);
const pipeline5 = [
  {
    $match: {
      "tomatoes.critic.rating": { $exists: true },
      "tomatoes.viewer.rating": { $exists: true },
      "imdb.votes": { $gte: minVotes5 },
    },
  },
  { $limit: Math.min(700, EMBEDDED_AFTER_MATCH * 2) },
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

// mflix_language_country_reach
const COMMENT_6 = "mflix_language_country_reach";

const minRating6 = rand(4, 7);
const limitP6 = rand(8, 24);
const pipeline6 = [
  { $match: { languages: { $exists: true }, countries: { $exists: true }, "imdb.rating": { $gte: minRating6 } } },
  { $limit: Math.min(500, EMBEDDED_AFTER_MATCH + 120) },
  { $unwind: "$languages" },
  { $unwind: "$countries" },
  {
    $lookup: {
      from: "embedded_movies",
      let: { lang: "$languages" },
      pipeline: [
        { $match: { $expr: { $in: ["$$lang", { $ifNull: ["$languages", []] }] } } },
        { $project: { year: 1, "imdb.rating": 1 } },
        { $limit: LOOKUP_SUB_CAP },
      ],
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
    },
  },
  {
    $addFields: {
      avg_rating: { $round: ["$avg_rating", 1] },
      global_reach_score: {
        $round: [{ $multiply: ["$avg_pool_size", "$countries_produced"] }, 0],
      },
    },
  },
  { $sort: { [pick(["global_reach_score", "total_films", "countries_produced"])]: -1 } },
  { $limit: limitP6 },
];

// mflix_runtime_zscore_outliers
const COMMENT_7 = "mflix_runtime_zscore_outliers";

const minYear7 = rand(1960, 1990);
const maxYear7 = rand(2005, 2020);
const limitP7 = rand(15, 40);
const pipeline7 = [
  { $match: { runtime: { $exists: true, $gt: 0 }, year: { $gte: minYear7, $lte: maxYear7 } } },
  { $limit: OUTLIER_PRE_GROUP_CAP },
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

const aggregateWorkloads = pipelines.map((p) => ({
  type: "aggregate",
  appName: APP_NAME_AGG,
  collection: "embedded_movies",
  name: p.name,
  pipeline: p.pipeline,
  comment: p.comment,
}));

// mflix_find_workloads (per-query appName)
const fy1 = rand(1975, 2000);
const fy2 = rand(fy1, 2020);
const findMoviesYearRating = {
  type: "find",
  appName: "workload-mflix-movies-year-rating",
  collection: "movies",
  name: "Find movies: year window + IMDb floor",
  comment: "mflix_movies_year_imdb_votes",
  filter: {
    year: { $gte: fy1, $lte: fy2 },
    "imdb.rating": { $gte: rand(4, 8) },
    "imdb.votes": { $gte: rand(100, 5000) },
  },
  project: { title: 1, year: 1, rated: 1, "imdb.rating": 1, "imdb.votes": 1, genres: 1, _id: 0 },
  sort: { year: -1, "imdb.rating": -1 },
  limit: rand(12, 45),
};

const gPick = pickN(MFLIX_GENRES, rand(1, 3));
const findMoviesGenres = {
  type: "find",
  appName: "workload-mflix-movies-genres",
  collection: "movies",
  name: "Find movies: genre overlap",
  comment: "mflix_movies_genres_runtime",
  filter: { genres: { $in: gPick }, runtime: { $gte: rand(70, 95), $lte: rand(120, 200) } },
  project: { title: 1, genres: 1, runtime: 1, year: 1, "imdb.rating": 1, _id: 0 },
  sort: { "imdb.rating": -1 },
  limit: rand(10, 35),
};

const findMoviesCommented = {
  type: "find",
  appName: "workload-mflix-movies-commented",
  collection: "movies",
  name: "Find movies: num_mflix_comments",
  comment: "mflix_movies_comment_count",
  filter: { num_mflix_comments: { $gte: rand(1, 25) } },
  project: { title: 1, year: 1, num_mflix_comments: 1, "imdb.rating": 1, _id: 0 },
  sort: { num_mflix_comments: -1 },
  limit: rand(8, 28),
};

const ratedPick = pickN(["G", "PG", "PG-13", "R", "NOT RATED", "UNRATED"], rand(2, 4));
const findMoviesRatedRuntime = {
  type: "find",
  appName: "workload-mflix-movies-rated-runtime",
  collection: "movies",
  name: "Find movies: rating labels + runtime",
  comment: "mflix_movies_rated_runtime",
  filter: {
    rated: { $in: ratedPick },
    runtime: { $gte: rand(75, 100), $lte: rand(130, 190) },
  },
  project: { title: 1, rated: 1, runtime: 1, year: 1, directors: 1, _id: 0 },
  sort: { runtime: 1 },
  limit: rand(15, 45),
};

const findMoviesTomatoes = {
  type: "find",
  appName: "workload-mflix-movies-tomatoes",
  collection: "movies",
  name: "Find movies: Tomatoes critic/viewer",
  comment: "mflix_movies_tomato_metacritic",
  filter: {
    "tomatoes.critic.rating": { $gte: rand(4, 7) },
    "tomatoes.viewer.rating": { $gte: rand(3, 8) },
    metacritic: { $gte: rand(40, 75) },
  },
  project: {
    title: 1,
    year: 1,
    metacritic: 1,
    "tomatoes.critic.rating": 1,
    "tomatoes.viewer.rating": 1,
    _id: 0,
  },
  sort: { metacritic: -1 },
  limit: rand(10, 32),
};

const emailNeedle = pick(["@gmail", "@yahoo", "@hotmail", ".edu", ".org"]);
const emailRegex = emailNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const findUsersEmail = {
  type: "find",
  appName: "workload-mflix-users-email",
  collection: "users",
  name: "Find users: email substring",
  comment: "mflix_users_email_substr",
  filter: { email: { $regex: emailRegex } },
  project: { name: 1, email: 1, _id: 0 },
  sort: { name: 1 },
  skip: rand(0, 50),
  limit: rand(6, 28),
};

let cd1 = new Date(rand(2008, 2014), rand(0, 11), rand(1, 28));
let cd2 = new Date(rand(2015, 2022), rand(0, 11), rand(1, 28));
if (cd1 > cd2) [cd1, cd2] = [cd2, cd1];
const findCommentsByDate = {
  type: "find",
  appName: "workload-mflix-comments-date",
  collection: "comments",
  name: "Find comments: date range",
  comment: "mflix_comments_date_window",
  filter: { date: { $gte: cd1, $lte: cd2 } },
  project: { name: 1, movie_id: 1, date: 1, text: 1, _id: 0 },
  sort: { date: -1 },
  skip: rand(0, 35),
  limit: rand(10, 40),
};

const statePick = pick(["CA", "NY", "TX", "FL", "WA", "IL", "OH", "GA"]);
const findTheatersState = {
  type: "find",
  appName: "workload-mflix-theaters-state",
  collection: "theaters",
  name: "Find theaters: by state",
  comment: "mflix_theaters_by_state",
  filter: { "location.address.state": statePick },
  project: { theaterId: 1, "location.address.city": 1, "location.address.state": 1, _id: 0 },
  sort: { theaterId: 1 },
  limit: rand(12, 45),
};

const tidLo = rand(1, 500);
const findTheatersIdRange = {
  type: "find",
  appName: "workload-mflix-theaters-id",
  collection: "theaters",
  name: "Find theaters: theaterId range",
  comment: "mflix_theaters_id_range",
  filter: { theaterId: { $gte: tidLo, $lte: tidLo + rand(120, 500) } },
  project: { theaterId: 1, "location.geo": 1, _id: 0 },
  sort: { theaterId: 1 },
  limit: rand(12, 40),
};

const findSessionsSample = {
  type: "find",
  appName: "workload-mflix-sessions-sample",
  collection: "sessions",
  name: "Find sessions: sample slice",
  comment: "mflix_sessions_user_skip_limit",
  filter: { user_id: { $exists: true, $ne: "" } },
  project: { user_id: 1, _id: 0 },
  sort: { user_id: 1 },
  skip: rand(0, 80),
  limit: rand(5, 28),
};

const findWorkloads = [
  findMoviesYearRating,
  findMoviesGenres,
  findMoviesCommented,
  findMoviesRatedRuntime,
  findMoviesTomatoes,
  findUsersEmail,
  findCommentsByDate,
  findTheatersState,
  findTheatersIdRange,
  findSessionsSample,
];

const workloads = [...aggregateWorkloads, ...findWorkloads];

async function main() {
  const selected = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  const clientOpts = {
    maxPoolSize: 3,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  };

  const clientsByApp = new Map();

  async function dbForApp(appName) {
    if (!clientsByApp.has(appName)) {
      const c = new MongoClient(mongoUriFor(appName), clientOpts);
      await c.connect();
      clientsByApp.set(appName, c);
    }
    return clientsByApp.get(appName).db("sample_mflix");
  }

  try {
    console.log(
      `Caps: embedded_movies≤${EMBEDDED_AFTER_MATCH} after match · lookup sub≤${LOOKUP_SUB_CAP} · outlier pre-group≤${OUTLIER_PRE_GROUP_CAP} (env: MFLIX_EMBEDDED_CAP, MFLIX_LOOKUP_CAP, MFLIX_OUTLIER_CAP)\n`,
    );

    let toRun;
    if (selected) {
      if (selected < 1 || selected > workloads.length) {
        console.error(`Index must be 1–${workloads.length} (aggregates 1–${aggregateWorkloads.length}, finds ${aggregateWorkloads.length + 1}–${workloads.length})`);
        process.exit(1);
      }
      toRun = [workloads[selected - 1]];
    } else {
      const count = rand(1, workloads.length);
      const shuffled = [...workloads].sort(() => Math.random() - 0.5);
      toRun = shuffled.slice(0, count);
    }

    for (const w of toRun) {
      console.log(`\n▶ ${w.name}`);
      console.log(`  appName: ${w.appName}  collection: ${w.collection}`);
      console.log(`  comment: ${w.comment}\n`);

      const db = await dbForApp(w.appName);
      const start = Date.now();
      let results;

      if (w.type === "aggregate") {
        results = await db
          .collection(w.collection)
          .aggregate(w.pipeline, { allowDiskUse: true, comment: w.comment })
          .toArray();
      } else {
        let cur = db.collection(w.collection).find(w.filter, { comment: w.comment });
        if (w.project) cur = cur.project(w.project);
        if (w.sort) cur = cur.sort(w.sort);
        if (w.skip) cur = cur.skip(w.skip);
        cur = cur.limit(w.limit);
        results = await cur.toArray();
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`  Completed in ${elapsed}s — ${results.length} results`);
      const sample = results[0] != null ? JSON.stringify(results[0], null, 2).slice(0, 300) : "(none)";
      console.log(`  Sample:`, sample, results[0] != null ? "…\n" : "\n");
    }
  } finally {
    for (const c of clientsByApp.values()) {
      await c.close();
    }
    console.log("All connections closed");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
