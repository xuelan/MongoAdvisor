# Workload generation

The `scripts/workload*.js` helpers replay realistic read / aggregate
patterns against MongoDB so you have something meaningful to observe in the
MongoAdvisor dashboard while developing or demoing. They are also used to
**generate load** before running
[`scripts/measure-retention-footprint.js`](../scripts/measure-retention-footprint.js)
(see [Retention — measurement script](retention.md#measurement-script)).

- [Prerequisites — load Atlas sample data](#prerequisites--load-atlas-sample-data)
- [Workload connection string](#workload-connection-string)
- [Workload database user (`mongoadvisor_workload`)](#workload-database-user-mongoadvisor_workload)
- [Expand Airbnb listings (heavy workloads)](#expand-airbnb-listings-heavy-workloads)
- [Available scripts](#available-scripts)
- [Usage](#usage)
- [Useful environment variables](#useful-environment-variables)
- [Auto-created indexes](#auto-created-indexes)

## Prerequisites — load Atlas sample data

The workload scripts target Atlas's built-in
[**sample datasets**](https://www.mongodb.com/docs/atlas/sample-data/),
notably `sample_airbnb` and `sample_mflix`. Before running any
`workload*.js`:

1. **Pick or create an Atlas cluster** in the project you will connect to
   with your workload connection string (often the **monitored** cluster or
   a dedicated demo cluster).
2. **Load sample data** from the Atlas UI or
   [Atlas CLI](https://www.mongodb.com/docs/atlas/cli/stable/) — you need
   **Project Owner** on that project (organization owners must add
   themselves as project owners if needed). Follow MongoDB's guide:
   [Load sample data into Atlas](https://www.mongodb.com/docs/atlas/sample-data/load-sample-data/#std-label-load-sample-data).
3. Confirm in Compass or `mongosh` that databases such as `sample_airbnb`
   and `sample_mflix` exist on that cluster, then configure the URI your
   scripts use (see [Workload connection string](#workload-connection-string)).

Reference: the
[Sample Datasets index](https://www.mongodb.com/docs/atlas/sample-data/)
lists every available dataset and its namespaces.

> **Heads-up:** `workload-agg.js` and `workload-agg2.js` aggregate against
> `sample_airbnb.listingsAndReviews_big`, which is **not** part of the
> default Atlas sample load. Build it once with
> [`scripts/airbnb-expand-listings-big.js`](#expand-airbnb-listings-heavy-workloads).

## Workload connection string

**Two-cluster setup:** `npm start` always uses `MONGO_URI` → MongoAdvisor
**application** database (`mongoadvisor`). **Monitored** clusters are
separate: you register each URI in the **UI** (stored encrypted in
`clusters`). For **local workload scripts** only, if sample data is on
another host than the app DB, set `WORKLOAD_MONGO_URI` in `.env` to that
cluster's connection string; the scripts use `resolveWorkloadMongoUri()` in
[`scripts/workload-uri.js`](../scripts/workload-uri.js)
(`WORKLOAD_MONGO_URI` if set, otherwise `MONGO_URI`).

If the app DB cluster **also** has `sample_airbnb` / `sample_mflix`, you can
omit `WORKLOAD_MONGO_URI` and point `MONGO_URI` at a user that can read
both `mongoadvisor` and the sample DBs (the `--preset backend` user
includes `readAnyDatabase@admin`, which is enough to **read** sample data;
to **write** the expanded `listingsAndReviews_big` you still want the
workload user below).

## Workload database user (`mongoadvisor_workload`)

The `metrics_reader` style user
([`--preset metrics`](setup.md#3-create-the-monitored-cluster-database-user-scram))
can **read** `sample_airbnb` / `sample_mflix` but cannot run `$out` in
[`scripts/airbnb-expand-listings-big.js`](../scripts/airbnb-expand-listings-big.js)
(Atlas returns `not authorized`). For local **workload** and **expand**
tooling, create a separate SCRAM user with `--preset workload`, which
grants
[`readWriteAnyDatabase`](https://www.mongodb.com/docs/manual/reference/built-in-roles/#mongodb-authrole-readWriteAnyDatabase)
on `admin` (SCRAM / `authSource=admin`) — enough to read sample data and
write `listingsAndReviews_big`.

> **Security:** `readWriteAnyDatabase` is powerful. Use this user **only**
> for dev/demo workloads on a cluster you control. **Do not** register it
> as the monitored cluster connection in the MongoAdvisor UI for
> production (keep `metrics_reader` there).

Create the user (same bootstrap API keys as other `atlas:create-user`
flows; project = cluster where sample data lives):

```bash
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset workload \
  --project-id "<ATLAS_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username mongoadvisor_workload \
  --cluster-name "<Atlas cluster name>"
```

Then point `WORKLOAD_MONGO_URI` at that user (see
[Environment variables](setup.md#environment-variables)):

```env
WORKLOAD_MONGO_URI=mongodb+srv://mongoadvisor_workload:<password>@<host>/?authSource=admin
```

## Expand Airbnb listings (heavy workloads)

`workload-agg.js` and `workload-agg2.js` aggregate against
`sample_airbnb.listingsAndReviews_big`. Build it once from
`listingsAndReviews` by repeating each document with
`$addFields` → `$range` → `$unwind`:

```bash
node scripts/airbnb-expand-listings-big.js     # default 10 copies per listing (~10× row count)
node scripts/airbnb-expand-listings-big.js 25  # 25 copies per listing
```

Requires a user with `readWriteAnyDatabase` (or narrower write on
`sample_airbnb`) — use `mongoadvisor_workload` from the previous section,
not `metrics_reader`. See
[`scripts/airbnb-expand-listings-big.js`](../scripts/airbnb-expand-listings-big.js).

## Available scripts

Every query sets a descriptive `appName` and `comment`, so you can slice the
resulting `$queryStats` and Atlas slow-log rows by logical workload in the
dashboard.

| Script                          | Dataset                          | What it does                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `airbnb-expand-listings-big.js` | `sample_airbnb`                  | One-time data prep: copies `listingsAndReviews` into `listingsAndReviews_big` (default **10×** per doc, argv or `AIRBNB_EXPAND_TIMES`). Uses `WORKLOAD_MONGO_URI` or `MONGO_URI`. Used by `workload-agg*.js`.                                                                                                                                                                                |
| `workload.js`                   | all                              | **Subprocess-per-iteration** orchestrator for the heavy aggregation scripts. Spawns one Node child per iteration. Avoid huge iteration counts (>~50) — large values fork-bomb the OS (TLS handshake limits, file descriptors).                                                                                                                                                              |
| `workload-fast.js`              | `sample_mflix` + `sample_airbnb` | **Fast-workload** orchestrator. Spawns N (default 5) long-running workers in parallel for a duration. Worker mix controlled by `WORKLOAD_MIX` (`both` default = half find + half agg, `mflix` = finds only, `agg` = aggregations only).                                                                                                                                                     |
| `workload-fast-agg.js`          | `sample_airbnb` + `sample_mflix` | **Fast, index-backed aggregations.** 6 pipelines on `listingsAndReviews_big` (country / market / host portfolio / popular listings / recent reviews / property × bedrooms) + 4 mflix pipelines (`$group`, `$unwind`, `$bucket`). Creates the required airbnb indexes on first run (idempotent). Targets 100ms–1s latency.                                                                   |
| `workload-agg.js`               | `sample_airbnb`                  | Heavy host/listings lookup + group pipeline.                                                                                                                                                                                                                                                                                                                                                |
| `workload-agg2.js`              | `sample_airbnb`                  | Reviews unwind + seasonal rollups pipeline.                                                                                                                                                                                                                                                                                                                                                 |
| `workload-mflix.js`             | `sample_mflix`                   | Mixed aggregate + find workloads across mflix collections (intentionally includes some heavy shapes).                                                                                                                                                                                                                                                                                       |
| `workload-mflix-fast.js`        | `sample_mflix`                   | **Fast, index-only** find loop across every mflix collection. Single in-process loop. Runs for 5 minutes by default and only uses existing indexes (`cast`, `cast+runtime`, `genres`, `rated`, `runtime`, `email`, `user_id`, `location.geo` 2dsphere, `_id`, text index).                                                                                                                  |

## Usage

```bash
# Heavy-workload orchestrator (spawns 1 child per iteration — keep iter counts modest)
node scripts/workload.js          # default 10 iterations each
node scripts/workload.js 5        # 5 base iterations each
DURATION_MS=60000 node scripts/workload.js   # loop all workloads in parallel for 60s

# Run a single heavy workload
node scripts/workload-agg.js
node scripts/workload-agg2.js
node scripts/workload-mflix.js
node scripts/workload-mflix.js 3  # single pipeline (1-indexed) from the mflix list

# Fast, index-only single-process loops (each runs ~5 min by default)
node scripts/workload-mflix-fast.js                     # mflix finds only
node scripts/workload-fast-agg.js                       # airbnb_big + mflix aggregations
DURATION_MS=60000 node scripts/workload-mflix-fast.js   # 1 minute

# Fast-workload orchestrator (N parallel long-running workers — recommended for sustained ops/sec)
node scripts/workload-fast.js                          # 5 workers × 5 min, mixed (finds + aggs)
node scripts/workload-fast.js 10 600                   # 10 workers × 10 min, mixed
WORKLOAD_MIX=mflix node scripts/workload-fast.js 8 600 # finds-only (back-compat with old behavior)
WORKLOAD_MIX=agg   node scripts/workload-fast.js 6 600 # aggregations only (drives Performance Advisor)
MIN_SLEEP_MS=0 MAX_SLEEP_MS=20 \
  node scripts/workload-fast.js 8 1800                 # 8 workers × 30 min, dense load
npm run workload:fast -- 5 600                         # equivalent to default, via npm
```

> **Do not** use `node scripts/workload.js 3000`-style huge iteration counts
> — that spawns thousands of child Node processes simultaneously and
> triggers outbound socket exhaustion (`ENETUNREACH`), TLS handshake
> failures, and file-descriptor pressure (`spawn EBADF`) on the client.
> Use `workload-fast.js` for sustained throughput instead — it spawns a
> small fixed pool of long-running workers with persistent connection
> pools.

## Useful environment variables

| Variable                                                       | Script(s)                                            | Purpose                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `WORKLOAD_MONGO_URI`                                           | `workload-*.js`, `airbnb-expand-listings-big.js`     | Optional; overrides `MONGO_URI` for those scripts when sample data is on another cluster.                            |
| `READ_PREF`                                                    | all                                                  | Force `primary` or `secondary`; randomized per run otherwise.                                                        |
| `WORKLOAD_MIX`                                                 | `workload-fast.js`                                   | `both` (default) / `mflix` (finds only) / `agg` (aggregations only). Picks which children the orchestrator launches. |
| `DURATION_MS`                                                  | `workload-mflix-fast.js`, `workload-fast-agg.js`     | Total run time in ms (default `300000`).                                                                             |
| `MIN_SLEEP_MS` / `MAX_SLEEP_MS`                                | `workload-mflix-fast.js`, `workload-fast-agg.js`     | Jitter between ops (mflix-fast default `80`/`350`; fast-agg default `100`/`400`).                                    |
| `MAX_TIME_MS`                                                  | `workload-mflix-fast.js`, `workload-fast-agg.js`     | Per-query `maxTimeMS` cap (mflix-fast `5000`, fast-agg `8000`).                                                      |
| `MFLIX_EMBEDDED_CAP` / `MFLIX_LOOKUP_CAP` / `MFLIX_OUTLIER_CAP` | `workload-mflix.js`                                  | Shrink pipeline working sets to keep latency reasonable on small clusters.                                           |
| `AIRBNB_SEASON_CAP`                                            | `workload-agg2.js`                                   | Cap listings processed before `$unwind: $reviews`.                                                                   |

Each fast worker uses a distinct `appName` per query template (for example
`workload-mflix-fast-em-cast`, `workload-fast-agg-airbnb-country-property`,
`workload-fast-agg-mflix-coactors`), so each index-backed shape shows up
as its own entry in the dashboard's per-app charts.

## Auto-created indexes

`workload-fast-agg.js` creates these indexes on `listingsAndReviews_big` on
first run (idempotent — instant no-op on subsequent runs):

| Index name                              | Keys                                              |
| --------------------------------------- | ------------------------------------------------- |
| `workload_address_country`              | `{ "address.country": 1 }`                        |
| `workload_address_market`               | `{ "address.market": 1 }`                         |
| `workload_host_host_id`                 | `{ "host.host_id": 1 }`                           |
| `workload_property_type_bedrooms`       | `{ property_type: 1, bedrooms: 1 }`               |
| `workload_country_last_review`          | `{ "address.country": 1, last_review: -1 }`       |
| `workload_country_reviews`              | `{ "address.country": 1, number_of_reviews: -1 }` |

Drop them with
`db.listingsAndReviews_big.dropIndex("workload_address_country")` etc. if
you want to test cold-start latency.
