# MongoAdvisor

MongoAdvisor rethinks MongoDB observability. Instead of yet another raw-metrics dashboard, or auditing tool, it continuously analyzes your clusters and delivers **actionable recommendations** with direct links to the exact playbook — turning insight into action in seconds, not hours. So you can keep innovating and scaling.

**What it collects (per registered cluster):**

- `$queryStats` per replica-set member (topology discovered via `hello`).
- Atlas **Performance Advisor** slow-query log lines (optional — requires a read-only Atlas API key).
- `$indexStats`, `collStats`, `dbStats` for unused/redundant-index and storage/fragmentation views.
- Oplog window (first / last `ts` on `local.oplog.rs`) and disk usage.

All telemetry is persisted to a central MongoDB database and surfaced in a browser dashboard served from the same Node process.

> **Deployment scope:** replica sets are fully supported today. Sharded-cluster support is on the [roadmap](#roadmap).

## Bootstrap (Atlas)

Use this sequence for a **new** deployment. You need **two different programmatic API key pairs**:


| Key                       | Typical Atlas roles                                                                                                      | Used for                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Bootstrap / admin key** | Enough privilege to **create database users** on a project (e.g. **Project Owner** or **Project Database Access Admin**) | `npm run atlas:create-user` (steps 1 and 3), or `POST /api/atlas/database-users` / `POST /api/clusters/:id/atlas-database-users` |
| **Monitoring key**        | **Project Read Only** + **Project Data Access Read Only** → API values `GROUP_READ_ONLY`, `GROUP_DATA_ACCESS_READ_ONLY`  | Stored in MongoAdvisor per cluster for **Performance Advisor** slow-query logs (`collector.js`)                                  |


Create the bootstrap key in Atlas **Access Manager** if you do not already have one. The monitoring key is created in step 2 and is **not** the same as the bootstrap key (read-only keys cannot create users).

**Prerequisites:** `npm install` in this repo; Atlas **project IDs** for the backend cluster project and each monitored workload project; backend Atlas cluster reachable for `MONGO_URI`.

### 1. Create the backend application user (SCRAM)

Creates `readWrite` on `mongoadvisor` plus `readAnyDatabase` on `admin` (SCRAM auth against `admin` — Atlas requirement). Pass the **bootstrap** public/private keys (not the monitoring key).

```bash
# databaseName (auth): admin | roles: readWrite @ mongoadvisor, readAnyDatabase @ admin
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset backend \
  --project-id "<BACKEND_ATLAS_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username mongoadvisor_app
```

Optional: `--cluster-name "<backend Atlas cluster name>"` scopes the user to one cluster.

Alternatives: Atlas UI **Database Access**, or the HTTP API documented under [Atlas database users (CLI and HTTP API)](#atlas-database-users-cli-and-http-api) (same payloads as `npm run atlas:create-user`).

Example `MONGO_URI`: `mongodb+srv://mongoadvisor_app:<password>@<host>/mongoadvisor?authSource=admin`

### 2. Create the monitoring programmatic API key (read-only)

For each **monitored** Atlas project, create a key MongoAdvisor will store for the Performance Advisor API. The **HTTP caller** must have **Project Owner** or **Project Access Manager** on that project (often your personal Atlas login via `curl --digest`, or the bootstrap key if it has that role on the monitored project).

**Atlas UI (recommended):** Organization (or project) **Access Manager** → **Applications** / programmatic keys → create with **Project Read Only** and **Project Data Access Read Only** → assign to the workload project → copy **public** and **private** once.

**REST** — [Create and Assign One Organization API Key to One Project](https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-creategroupapikey/) (`POST /api/atlas/v2/groups/{groupId}/apiKeys`). Response is **HTTP 200** and includes `publicKey` and `privateKey` only at creation time:

```bash
curl --user "<CALLER_PUBLIC_KEY>:<CALLER_PRIVATE_KEY>" \
  --digest \
  --header "Content-Type: application/vnd.atlas.2023-01-01+json" \
  --header "Accept: application/vnd.atlas.2023-01-01+json" \
  -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/<MONITORED_PROJECT_ID>/apiKeys" \
  --data '{
    "desc": "MongoAdvisor Performance Advisor read key",
    "roles": [
      "GROUP_READ_ONLY",
      "GROUP_DATA_ACCESS_READ_ONLY"
    ]
  }'
```

If slow-query ingestion returns **403**, confirm roles against current [Atlas programmatic access](https://www.mongodb.com/docs/atlas/configure-api-access/) docs (Atlas changes role names over time).

### 3. Create the monitored cluster database user (SCRAM)

Collector connects with this **MongoDB** user (`metrics_reader` pattern). Use `--preset metrics` on the **monitored** project; `--cluster-name` must match the **Atlas cluster name**.

```bash
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset metrics \
  --project-id "<MONITORED_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username metrics_reader \
  --cluster-name "<Atlas cluster name>"
```

**MongoDB roles for `--preset metrics`** (see `src/atlas-db-users.js`): the user is created with `**databaseName: admin**` (SCRAM / `authSource=admin`) and these built-in roles:


| Role              | Database | Purpose                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `clusterMonitor`  | `admin`  | Server stats, topology, `$queryStats`, `dbStats`, replica set / process info used by the collector       |
| `readAnyDatabase` | `admin`  | Read user collections across databases for `$indexStats`, storage / fragmentation walks, namespace lists |
| `read`            | `local`  | Read `local.oplog.rs` for oplog window sampling                                                          |


When you pass `**--cluster-name**`, Atlas also attaches a **cluster scope** (`CLUSTER`) so the user applies only to that deployment; omit `--cluster-name` only if you intentionally want a **project-wide** database user.

Example connection string: `mongodb+srv://metrics_reader:<password>@<host>/?authSource=admin`

To run `**airbnb-expand-listings-big.js`** (`$out`) or other sample **writes** from this repo, create a separate `**mongoadvisor_workload`** user with `**--preset workload**` (`readWriteAnyDatabase`) — see [Workload database user (mongoadvisor_workload)](#workload-database-user-mongoadvisor_workload).

### 4. Configure environment variables

Do **not** commit secrets. Locally, copy `.env.example` to `.env`. In production, set the same variable **names** via your platform (Kubernetes secrets, PaaS env, systemd, etc.):


| Variable             | Purpose                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`          | From step 1 (`authSource=admin` on Atlas) — **MongoAdvisor app database** only (`npm start`, `ensure-indexes`, decrypt script reading `clusters`, etc.).                                                                                                                                                                                 |
| `MONGO_DB`           | Application database name (default `mongoadvisor`)                                                                                                                                                                                                                                                                                       |
| `ENCRYPTION_KEY`     | 64 hex chars — encrypts stored cluster URIs and Atlas private keys in the app DB                                                                                                                                                                                                                                                         |
| `PORT`               | Optional (default `3000`)                                                                                                                                                                                                                                                                                                                |
| `WORKLOAD_MONGO_URI` | **Optional.** If your **sample datasets** (`sample_airbnb`, `sample_mflix`) live on a **different** cluster than the app DB, set this to that cluster’s URI for `workload*.js` and `airbnb-expand-listings-big.js`. If unset, those scripts use `MONGO_URI`. Monitored production URIs stay in the UI / `clusters` collection, not here. |


```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Start the application

```bash
npm start
```

Dashboard: `http://localhost:3000` (or your `PORT`). If the application database is unreachable, the banner explains it; `/api/health` drives the header badge.

### 6. Register the monitored cluster in the UI

Under **Monitored Clusters**:

- **Cluster name** — use the same string as the Atlas cluster name (scopes Atlas user creation and console links).
- **Connection string** — URI for `metrics_reader` from step 3.
- **Atlas Project ID** — monitored project (`MONITORED_PROJECT_ID`).
- **Atlas Public API Key** / **Atlas Private API Key** — the **monitoring** key from step 2 (not the bootstrap key).

Without Atlas keys, `$queryStats` and other DB-backed collectors still run; **Performance Advisor** slow-query enrichment is skipped.

---

## Quick Start (local development)

When users and keys already exist:

```bash
npm install
cp .env.example .env
# Set MONGO_URI, MONGO_DB, ENCRYPTION_KEY (see Bootstrap above)

npm start
# Or: npm run dev
```

## Configuration


| Variable         | Description                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`      | Connection string for the **MongoAdvisor backend** database (stores clusters, metrics, encrypted secrets) |
| `MONGO_DB`       | Database name on that cluster (default: `mongoadvisor`)                                                   |
| `PORT`           | HTTP port (default: `3000`)                                                                               |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored credentials                                                         |


Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## MongoDB users and roles

This complements **[Bootstrap (Atlas)](#bootstrap-atlas)** with copy-paste examples, role tables, and HTTP details.

You need **two different identities**: one for the app’s own database, and one (per monitored cluster) embedded in each connection string you register in the UI.

**Atlas:** You must create database users with the [Atlas UI](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/), [Atlas CLI](https://www.mongodb.com/docs/atlas/cli/stable/command/atlas-dbusers-create/), [Atlas Administration API](https://www.mongodb.com/docs/atlas/reference/api-resources-spec/v2/#tag/Database-Users), or another supported integration. Changes made only with `mongosh` / `db.createUser` on the cluster can be **rolled back** by Atlas.

**Self-managed** (not Atlas): you can create the same roles with `db.createUser` in `mongosh` as usual.

### 1. Backend application user (`MONGO_URI`)

This user must **read and write** the MongoAdvisor application database (default `mongoadvisor`) and typically needs `readAnyDatabase` on `admin` so the same URI can read other databases on the backend cluster (for example `scripts/workload*.js` against Atlas sample data). On **Atlas**, SCRAM users must use the `admin` authentication database (`DATABASE_NAME_INVALID_ADMIN` if you use another auth DB); `--preset backend` sets Atlas `databaseName` to `admin` with `readWrite` on `mongoadvisor` and `readAnyDatabase` on `admin`. On **self-managed** MongoDB you can grant the same two roles with auth DB `admin` (or narrow reads if you do not need cross-database access).

Create the user on Atlas with the Administration API (Digest auth). Use the **bootstrap** API key pair (must be allowed to create database users), not the read-only monitoring key from bootstrap step 2:

```bash
# No --role flag: --preset backend sends these to Atlas (SCRAM):
#   databaseName (auth): admin   ← required on Atlas
#   roles: readWrite @ mongoadvisor, readAnyDatabase @ admin
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset backend \
  --project-id "<Atlas project ID>" \
  --public-key "<Atlas API public key>" \
  --private-key "<Atlas API private key>" \
  --username mongoadvisor_app
```

On self-managed hosts, equivalent roles are `readWrite` on `mongoadvisor` and `readAnyDatabase` on `admin` (often created with auth DB `admin`); this repo's API maps `--preset backend` to the Atlas-safe payload above.

Optional: `--cluster-name "<Atlas cluster name>"` scopes the user to a single cluster in the project.

Example `MONGO_URI` after creation on Atlas: `mongodb+srv://mongoadvisor_app:<password>@<host>/mongoadvisor?authSource=admin`

### 2. Monitored cluster user (connection string per cluster)

The collector runs commands and aggregations against **each registered cluster**. A minimal **built-in** combination that matches the current code paths is:


| Role              | Database | Why                                                                                                                                                                                      |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clusterMonitor`  | `admin`  | Monitoring commands, `listDatabases`, and `$queryStats` (`queryStatsRead` — see [MongoDB `$queryStats](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)`) |
| `readAnyDatabase` | `admin`  | `listCollections`, `$indexStats`, `collStats` on user databases                                                                                                                          |
| `read`            | `local`  | Read `local.oplog.rs` for oplog window sampling (`readAnyDatabase` does not cover `local`)                                                                                               |


Create with the API script (recommended on Atlas):

```bash
# No --role flag: --preset metrics sends these to Atlas (SCRAM):
#   databaseName (auth): admin
#   roles: clusterMonitor@admin, readAnyDatabase@admin, read@local
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset metrics \
  --project-id "<Atlas project ID>" \
  --public-key "<Atlas API public key>" \
  --private-key "<Atlas API private key>" \
  --username metrics_reader \
  --cluster-name "<Atlas cluster name>"
```

Omit `--cluster-name` if you want a project-wide database user (all clusters in the project).

Example URI: `mongodb+srv://metrics_reader:<password>@<host>/?authSource=admin`.

Registering a cluster in the UI is always a **new** row (no upsert by name). To **change** the connection string or Atlas fields, click **Edit connection** next to **Add Cluster**, pick the cluster, edit fields, then **Save changes** (or run `scripts/update-cluster-uri.js` and **restart** the server if you use the script—the UI `PATCH` clears pools in-process).

**Atlas notes:** Slow-query log ingestion uses the **Atlas Admin API** (project ID + API keys in the form), not the database user. `$queryStats` may require a sufficient Atlas tier and MongoDB version; see MongoDB documentation for your deployment.

### Atlas database users (CLI and HTTP API)

SCRAM users are **not** created from the web UI. Use `npm run atlas:create-user` (see [Bootstrap (Atlas)](#bootstrap-atlas)) or call the routes below (same presets as `src/atlas-db-users.js`). Optional server env `ATLAS_BACKEND_PROJECT_ID` and `ATLAS_BACKEND_PUBLIC_KEY` are exposed via `GET /api/atlas/database-users/defaults` so scripts or `curl` can prefill non-secrets only (never put a private API key in `.env` for a browser).


| Method | Path                                     | Purpose                                                                                                                                                                                                                    |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/atlas/database-users/presets`      | Preset ids and descriptions (`backend`, `metrics`, `workload`).                                                                                                                                                            |
| `GET`  | `/api/atlas/database-users/defaults`     | JSON `{ projectId, publicKey }` from optional env (non-secrets only).                                                                                                                                                      |
| `POST` | `/api/atlas/database-users`              | Body: `preset`, `projectId`, `publicKey`, `privateKey`, `username`, `password`, optional `clusterName` (Atlas cluster name for scope).                                                                                     |
| `POST` | `/api/clusters/:id/atlas-database-users` | Uses **stored** Atlas Project ID + API keys on that cluster. Body: `username`, `password`, optional `preset` (default `metrics`), optional `scopeToCluster` (default `true` → scope to the cluster’s registered **name**). |


The stock server does **not** add HTTP authentication to these routes; treat them like the rest of the admin API and protect them at the network or proxy layer.

## Architecture

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ Source MongoDB cluster(s)  │       │ MongoAdvisor backend DB    │
│                            │       │                            │
│   ┌────┐ ┌────┐ ┌────┐     │  ──►  │ collector.js               │
│   │ P  │ │ S  │ │ S  │     │       │ · $queryStats (per host)   │
│   └────┘ └────┘ └────┘     │       │ · Atlas Logs API (opt.)    │
└────────────────────────────┘       │ · hello / topology         │
                                     │ · $indexStats / collStats  │
                                     │ · dbStats, oplog window    │
                                     │ · daily storage scan       │
                                     │                            │
                                     │ Collections: clusters,     │
                                     │ topologies, query_stats,   │
                                     │ slow_queries, index_stats, │
                                     │ storage_stats, disk_usage, │
                                     │ oplog_window, monitor_logs │
                                     │                            │
                                     │ Express :3000 · public/    │
                                     └────────────────────────────┘
```

Slow-query log lines are fetched with the **Atlas Admin API** (keys in the UI), not the MongoDB database user on the arrow above.

## Data collection

Embedded pollers run on fixed intervals (see `src/collector.js`):


| Collector                             | Interval                                    | Source                                                                                                     | Stored as                   |
| ------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| Topology discovery                    | 5 min + on URI change + manual `Refresh`    | `hello`, `serverStatus.catalogStats`, `listDatabases`; SRV resolution of the URI hostname                  | `topologies`                |
| `$queryStats`                         | 5 min                                       | Each replica member via `directConnection`                                                                 | `query_stats`               |
| Atlas slow query logs                 | 5 min                                       | Performance Advisor API per Atlas process (if keys set); rolling **24h + 6m overlap** lookback             | `slow_queries`              |
| `$indexStats` (unused / redundant)    | 10 min                                      | Per host / primary                                                                                         | `index_stats`               |
| Disk usage (`dbStats` on `admin`)     | 5 min                                       | Cluster connection                                                                                         | `disk_usage`                |
| Oplog window                          | 5 min                                       | First/last `ts` on `local.oplog.rs`                                                                        | `oplog_window`              |
| Storage & fragmentation (`collStats`) | Daily ~3:00 local; once on startup; on cluster create | Cluster connection                                                                                         | `storage_stats`             |


On startup, **all collectors** (including storage) run once after the initial topology discovery so per-host queries see a populated `topologies` document; the periodic timers start after that initial pass completes. When a new cluster is registered via `POST /api/clusters`, discovery + a one-shot `$queryStats` + storage pass run for that cluster so the dashboard fills in immediately.

Queries from internal agents (`MongoDB Automation Agent`, `MongoDB Monitoring Module`) and from the MongoAdvisor app itself (`appName: "mongoadvisor"`) are filtered at ingestion. System DBs (`admin`, `config`, `local`, `mongoadvisor`, `#mongodb-mcp`) are dropped from `query_stats` and `slow_queries` ingestion (see `src/hidden-dbs.js`).

### Topology discovery and Atlas DNS aliases

`hello` returns the **internal replica set member names** (e.g. `atlas-xxxxxx-shard-00-01.mongodb.net`). When a single Atlas project has multiple cluster DNS aliases that point at the same physical replica set, `hello.hosts` looks identical for both — that is misleading in the UI and breaks per-cluster filtering.

Discovery handles this by resolving the SRV record from the URI hostname (`_mongodb._tcp.<cluster-alias>.mongodb.net`) and storing the **alias-prefixed** hostnames (e.g. `workload-shard-00-01.mongodb.net`) when they differ from `hello.hosts`. The Performance Advisor `slowQueryLogs` collector additionally calls Atlas `listGroupProcesses` to use the **correct Atlas process ID** for each replica member instead of relying on `hello.hosts`.

If `hello` fails (e.g. wrong credentials in the URI) but SRV resolution succeeds, the topology is still saved with SRV-derived hostnames and `helloOk: false`. The UI shows a red **⚠ auth failed** badge next to the topology so the misconfiguration is obvious.

When `hello` succeeds, discovery also runs `serverStatus({ catalogStats: 1 })` and `listDatabases({ nameOnly: true })`. The result is stored on the topology document as `catalogStats`, `databases`, and `catalogTooLarge` (true when `catalogStats.collections > 10_000`). Heavy per-collection collectors (`storage_stats`, `index_stats`) are skipped for clusters with `catalogTooLarge: true` and the UI surfaces a **⚠ N collections — heavy scans skipped** badge with a link to the [Reduce the Number of Collections](https://www.mongodb.com/docs/manual/data-modeling/design-antipatterns/reduce-collections/#reduce-the-number-of-collections) anti-pattern doc. The Databases filter (`/api/metrics/databases`) reads from `topologies.databases`, so even brand-new clusters with no `query_stats` data yet still show database checkboxes immediately after the first discovery.

### Stored document timestamp (query_stats and slow_queries)

Time filters (`since`, time range in the UI) and sorts use the `timestamp` field on each stored row. It does **not** always mean "the instant that user query finished":


| Collection     | What `timestamp` represents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_stats`  | Prefer `metrics.latestSeenTimestamp`: UTC when the server last **observed activity** for this stats key (still aggregated — not a single query's "finished at" instant). If missing, use `asOf`: UTC when that partition row was read from the `[$queryStats](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)` virtual collection (also not per-query event time). Then **poll time**. `metrics.lastExecutionMicros` is execution *duration*, not a calendar time — it is not used as `timestamp`. |
| `slow_queries` | Prefer the **log event time** parsed from the Performance Advisor line (MongoDB structured log field `t`). If that cannot be parsed, `timestamp` is the **collector run time** when the slow-query batch was ingested.                                                                                                                                                                                                                                                                                                             |


Metrics routes filter with `since` against this same `timestamp` field.

### UTC and timestamps (database vs UI)

**MongoDB (application database)**  
BSON **Date** values represent a **single instant in time** (internally: milliseconds since the Unix epoch). Tools such as Compass usually render that as **UTC ISO** (suffix `Z` or `+00:00`). That is a **display convention** for the same moment you would read on a wall clock in any timezone, not a second parallel timeline.


| Source                   | What you see / store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `query_stats.timestamp`  | Prefer `metrics.latestSeenTimestamp`, then `asOf`, then `new Date()` at poll time (`[$queryStats](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)`). The collector reads `latestSeenTimestamp` from the same **cloned** `metrics` subdocument that is stored (EJSON round-trip can change BSON shapes from the raw cursor), so `timestamp` matches `metrics.latestSeenTimestamp` when that field is present and parseable. `asOf` is partition read time, not a single-query event time. |
| `slow_queries.timestamp` | Prefer log event time from structured field `t` in [MongoDB log lines](https://www.mongodb.com/docs/manual/reference/log-messages/) (UTC in JSON). If unparsed, collector ingest time.                                                                                                                                                                                                                                                                                                                                   |
| `monitor_logs.timestamp` | Set when the row is written (`new Date()` on the Node process). Still a BSON instant; server OS timezone does not create a second stored clock.                                                                                                                                                                                                                                                                                                                                                                          |


**Dashboard UI (`public/app.js`)**  

- **Filtering:** For 5 min / 1 h / 1 d / 1 w, the client sends `since` as `new Date(Date.now() - rangeMs).toISOString()`. That means: **current instant from the browser** minus a **duration**, encoded as **UTC ISO** for the query string. The API uses `new Date(since)` and compares to `timestamp` — same instant math everywhere (Paris 11:44 and `09:44Z` are the same "now"; the window edge is one hour earlier in real time, not "subtract 1 from the local hour digit only").
- **"All"** clears `since` so metrics APIs can return rows from any `timestamp`.
- **Labels only:** Disk usage and oplog panels use `toLocaleString()` for "Updated" / oplog bounds so the **browser shows local wall time** for humans. That does **not** change `since` or database values.

## Dashboard

The frontend (`public/`) uses Chart.js. Highlights:

- **Monitored clusters** — register URIs and optional Atlas API fields; **Edit connection** to update an existing cluster; topology refresh
- **Disk usage** and **oplog window** — per cluster gauges
- **Execution count / total time / slowest by appName** — bar charts (top 20)
- **Slow-query impact bubble** — appName + comment (top 20)
- **IO / CPU heatmaps** — treemaps from Atlas slow-query logs (top 20)
- **Unused / redundant indexes** — from `$indexStats` and prefix rules
- **Storage & fragmentation** — sortable table (daily data)

### Filters

Charts that use query stats or slow queries honor:


| Filter         | Description                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time range** | 5 min, 1 hour, 1 day, 1 week, or all                                                                                                                                         |
| **Nodes**      | One checkbox per replica set member (from topology); reset to "all checked" when the dashboard cluster select changes                                                        |
| **Databases**  | Distinct top-level databases from `query_stats`; system DBs and the app DB `mongoadvisor` hidden from the picker (see `src/hidden-dbs.js`); reset to "all checked" on switch |


## API endpoints


| Method   | Endpoint                                 | Description                                                                                               |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                            | Ping application database                                                                                 |
| `GET`    | `/api/clusters`                          | List clusters (secrets masked)                                                                            |
| `POST`   | `/api/clusters`                          | Register a cluster                                                                                        |
| `GET`    | `/api/clusters/:id`                      | One cluster                                                                                               |
| `PATCH`  | `/api/clusters/:id`                      | Update cluster (`name`, `uri`, Atlas fields, `isPolling`; omit `uri` / `atlasPrivateKey` to leave unchanged) |
| `DELETE` | `/api/clusters/:id`                      | Remove cluster                                                                                            |
| `POST`   | `/api/clusters/:id/atlas-database-users` | Create Atlas SCRAM user using stored cluster Atlas API keys                                               |
| `GET`    | `/api/atlas/database-users/presets`      | Preset ids for Atlas SCRAM user creation                                                                  |
| `GET`    | `/api/atlas/database-users/defaults`     | Optional `{ projectId, publicKey }` from server env (for scripts / `curl`)                                |
| `POST`   | `/api/atlas/database-users`              | Create Atlas SCRAM user (credentials in JSON body)                                                        |
| `GET`    | `/api/topologies`                        | All topologies                                                                                            |
| `POST`   | `/api/topologies/:id/discover`           | Refresh topology (also runs automatically after `PATCH /api/clusters/:id` when `uri` changes)              |
| `GET`    | `/api/metrics/databases`                 | Distinct top-level databases for filters                                                                  |
| `GET`    | `/api/metrics/namespaces`                | Distinct namespaces (for backwards compatibility / scripting)                                             |
| `GET`    | `/api/metrics/hosts`                     | Distinct hosts from topology                                                                              |
| `GET`    | `/api/metrics/app-load`                  | Aggregated load by appName                                                                                |
| `GET`    | `/api/metrics/query-stats`               | Raw `$queryStats`-backed snapshots                                                                        |
| `GET`    | `/api/metrics/app-analysis`              | App-level analysis aggregates                                                                             |
| `GET`    | `/api/metrics/impact-by-query`           | Per-query impact metrics                                                                                  |
| `GET`    | `/api/metrics/heatmap`                   | Heatmap payload (IO/CPU grouping)                                                                         |
| `GET`    | `/api/metrics/bubble`                    | Bubble chart payload                                                                                      |
| `GET`    | `/api/metrics/slow-queries`              | Slow query log documents                                                                                  |
| `GET`    | `/api/metrics/unused-indexes`            | Unused index rows                                                                                         |
| `GET`    | `/api/metrics/redundant-indexes`         | Redundant index rows                                                                                      |
| `GET`    | `/api/metrics/storage`                   | Storage / fragmentation rows                                                                              |
| `GET`    | `/api/metrics/disk-usage`                | Latest disk usage per cluster                                                                             |
| `GET`    | `/api/metrics/oplog-window`              | Latest oplog window per cluster                                                                           |
| `GET`    | `/api/metrics/monitor-logs`              | Collector/API audit (`?limit=`, `?since=`, `?clusterId=`, `?action=`, `?outcome=`)                        |


Common query parameters: `since` (ISO date, compared to each document's `timestamp` — see [Stored document timestamp (query_stats and slow_queries)](#stored-document-timestamp-query_stats-and-slow_queries)), `database` (repeatable, prefix-matches `namespace`), `namespace` (repeatable, exact match — takes precedence when both are sent), `host` (repeatable), `clusterId`.

## Application database indexes

Indexes are **not** created when the server starts. Run them manually after deploy or when the README index list changes:

```bash
npm run indexes:ensure
# Or: node scripts/ensure-indexes.js
```

Uses `MONGO_URI` and `MONGO_DB` from `.env` (same as the app). The script is `[scripts/ensure-indexes.js](scripts/ensure-indexes.js)`; it does **not** run from `[src/db.js](src/db.js)`.


| Collection      | Index name                         | Keys                                                          | Unique        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------- | ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_stats`   | `uniq_query_stats_observation`     | `clusterId`, `host`, `timestamp`, `keyHash`, `queryShapeHash` | yes           | One stored row per observation key **including `timestamp`**. Stored `timestamp` prefers `metrics.latestSeenTimestamp`, then `asOf`, then poll time (`[$queryStats](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)`). `bulkWrite` upserts use this full key set. When `latestSeenTimestamp` moves forward, a **new** row can appear (new instant in the compound key). `keyHash` may be null on older servers.                              |
| `slow_queries`  | `uniq_slow_log_dedupe`             | `clusterId`, `host`, `id`, `timestamp`, `millis`, `ctx`       | yes (partial) | Same logical key as `{ id, timestamp, millis, ctx, host }` plus `clusterId` so tenants do not collide. Partial index applies only when `id` is numeric ([log messages](https://www.mongodb.com/docs/manual/reference/log-messages/#filtering-by-known-log-id)). The collector `bulkWrite` upserts on that key set; `ctx` is stored as `""` when missing. Rows without a numeric `id` are `insertMany` only (not in the partial unique set — duplicates possible on re-poll). |
| `topologies`    | `uniq_topology_per_cluster`        | `clusterId`                                                   | yes           | At most one topology document per cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `monitor_logs`  | `monitor_logs_timestamp`           | `timestamp` (desc)                                            | no            | Recent audit rows for `/api/metrics/monitor-logs`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `index_stats`   | `index_stats_cluster_type_host_ns` | `clusterId`, `type`, `host`, `namespace`                      | no            | Unused / redundant index listings.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `storage_stats` | `storage_stats_cluster_ns`         | `clusterId`, `namespace`                                      | no            | Storage scan rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `disk_usage`    | `disk_usage_cluster_time`          | `clusterId`, `timestamp` (desc)                               | no            | Latest disk samples per cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `oplog_window`  | `oplog_window_cluster_time`        | `clusterId`, `timestamp` (desc)                               | no            | Latest oplog window samples.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |


All collections also have the default `_id` index. `clusters` is not listed above (only `_id` unless you add your own).

If `createIndex` fails (usually duplicate keys in existing data), clean duplicates or drop conflicting indexes, then run `npm run indexes:ensure` again.

### Decrypt a stored credential (`scripts/decrypt-field.js`)

MongoAdvisor stores sensitive cluster fields (`**uri`**, `**atlasPrivateKey**`) in the application database as **AES-256-GCM** ciphertext (see `[src/crypto.js](src/crypto.js)`). The API and UI never return the full plaintext URI.

If you **operate** the deployment and still have the same `**ENCRYPTION_KEY`** as when the value was written, you can decrypt a copied field locally for recovery or verification. **Do not** commit ciphertext or plaintext; treat script output like any other secret.

**Prerequisites:** `.env` in the repo root with `**ENCRYPTION_KEY`** (64 hex characters — same as the running app).

**Get the ciphertext:** In MongoDB Compass, `mongosh`, or any client connected to the **application** database, read `mongoadvisor.clusters` (or your `MONGO_DB`) and copy the **string value** of `uri` or `atlasPrivateKey` (three colon-separated hex segments: IV, auth tag, ciphertext).

**Run:**

```bash
# Pass the packed string as one argument (quote it in the shell — it contains colons)
npm run decrypt:field -- '<ivHex:tagHex:cipherHex>'

# Equivalent
node scripts/decrypt-field.js '<ivHex:tagHex:cipherHex>'

# Or pipe (useful if the string is very long)
echo '<ivHex:tagHex:cipherHex>' | node scripts/decrypt-field.js --stdin
```

The script prints a **stderr** warning, then writes the **plaintext** to **stdout** (for example a full `mongodb+srv://…` connection string). If the input is not in MongoAdvisor encrypted format, or the key is wrong, it exits with an error.

### Slow query document fields (log-derived)


| Field       | Source                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`        | Top-level `id` in the JSON slow-operation log line (integer), when present.                                      |
| `ctx`       | Top-level `ctx` (e.g. connection thread id). Stored as `""` when missing so the unique index remains stable.     |
| `truncated` | `true` / `false` when the log exposes a `truncated` field (top-level or under `attr`); omitted when not present. |


## Project structure

```
src/
├── server.js          # Express entry point
├── db.js              # Backend MongoDB client (MONGO_URI / MONGO_DB)
├── crypto.js          # AES-256-GCM for stored credentials
├── collector.js       # Pollers ($queryStats, logs, indexes, storage, disk, oplog)
├── monitor-log.js     # Writes `monitor_logs` audit rows (collector + API)
├── discovery.js       # Topology via hello
├── pool-cache.js      # Connection pools (cluster + direct per host)
└── routes/
    ├── health.js
    ├── clusters.js
    ├── topologies.js
    └── metrics.js

public/
├── index.html
├── app.js
└── style.css

scripts/
├── ensure-indexes.js       # npm run indexes:ensure — app DB indexes (not run on server start)
├── decrypt-field.js        # npm run decrypt:field — decrypt stored uri / atlasPrivateKey (ENCRYPTION_KEY from .env)
├── workload-uri.js         # resolve WORKLOAD_MONGO_URI || MONGO_URI for workload scripts
├── airbnb-expand-listings-big.js  # build sample_airbnb.listingsAndReviews_big from listingsAndReviews ($range + $unwind)
├── workload.js             # Orchestrator: runs all workloads in parallel
├── workload-agg.js         # sample_airbnb analytics pipeline
├── workload-agg2.js        # sample_airbnb seasonal pipeline
├── workload-mflix.js       # sample_mflix mixed aggregate + find workloads
└── workload-mflix-fast.js  # sample_mflix fast, index-only loop (default 5 min)
```

## Workload generation

### First steps: load sample data in Atlas

The workload scripts expect Atlas’s built-in **sample databases** (notably `sample_airbnb` and `sample_mflix`). Before running them:

1. **Create or pick an Atlas cluster** in the same project you will connect to with your workload connection string (often the **monitored** cluster or a dedicated demo cluster).
2. **Load sample data** from the Atlas UI or Atlas CLI — you need **Project Owner** on that project (organization owners must add themselves as project owners if needed). Follow MongoDB’s guide: **[Load sample data into Atlas](https://www.mongodb.com/docs/atlas/sample-data/load-sample-data/#std-label-load-sample-data)**.
3. Confirm in Compass or `mongosh` that databases such as `**sample_airbnb`** and `**sample_mflix**` exist on that cluster, then configure the URI your scripts use (see [Workload connection string](#workload-connection-string) below).

### Workload database user (mongoadvisor_workload)

The `**metrics_reader**` style user (`[--preset metrics](#3-create-the-monitored-cluster-database-user-scram)`) can **read** `sample_airbnb` / `sample_mflix` but cannot run `**$out`** in `[scripts/airbnb-expand-listings-big.js](scripts/airbnb-expand-listings-big.js)` (Atlas returns `not authorized`). For local **workload** and **expand** tooling, create a separate SCRAM user with `**--preset workload`**, which grants `**readWriteAnyDatabase**` on `admin` (SCRAM / `authSource=admin`) — enough to read sample data and write `listingsAndReviews_big`.

**Security:** `readWriteAnyDatabase` is powerful. Use this user **only** for dev/demo workloads on a cluster you control. **Do not** register it as the monitored cluster connection in the MongoAdvisor UI for production (keep `**metrics_reader`** there).

Create the user (same bootstrap API keys as other `atlas:create-user` flows; project = cluster where sample data lives):

```bash
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset workload \
  --project-id "<ATLAS_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username mongoadvisor_workload \
  --cluster-name "<Atlas cluster name>"
```

Then point `**WORKLOAD_MONGO_URI**` at that user (see [Configure environment variables](#4-configure-environment-variables)):

```env
WORKLOAD_MONGO_URI=mongodb+srv://mongoadvisor_workload:<password>@<host>/?authSource=admin
```

**MongoDB role for `--preset workload`** (see `src/atlas-db-users.js`): `readWriteAnyDatabase` @ `admin` ([built-in role](https://www.mongodb.com/docs/manual/reference/built-in-roles/#mongodb-authrole-readWriteAnyDatabase) — read/write all non-system databases).

### Expand Airbnb listings (optional, for heavier workloads)

`workload-agg.js` and `workload-agg2.js` aggregate against `**sample_airbnb.listingsAndReviews_big**`. That collection is not part of the default Atlas sample load; build it once from `**listingsAndReviews**` by repeating each document with `$addFields` → `$range` → `$unwind`:

```bash
node scripts/airbnb-expand-listings-big.js     # default 10 copies per listing (~10× row count)
node scripts/airbnb-expand-listings-big.js 25  # 25 copies per listing
```

Requires a user with `**readWriteAnyDatabase**` (or narrower write on `sample_airbnb`) — use `**mongoadvisor_workload**` from the previous subsection, not `**metrics_reader**`. See `[scripts/airbnb-expand-listings-big.js](scripts/airbnb-expand-listings-big.js)`.

Scripts target those sample datasets so you have something meaningful to observe while developing or demoing. Every query sets a descriptive `appName` and `comment`, so you can slice the resulting `$queryStats` and Atlas slow-log rows by logical workload in the dashboard.

### Available scripts


| Script                          | Dataset         | What it does                                                                                                                                                                                                                                  |
| ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `airbnb-expand-listings-big.js` | `sample_airbnb` | One-time data prep: copies `listingsAndReviews` into `listingsAndReviews_big` (default **10×** per doc, argv or `AIRBNB_EXPAND_TIMES`). Uses `WORKLOAD_MONGO_URI` or `MONGO_URI`. Used by `workload-agg*.js`.                                 |
| `workload.js`                   | all             | Runs the other three scripts in parallel with a randomized iteration count.                                                                                                                                                                   |
| `workload-agg.js`               | `sample_airbnb` | Heavy host/listings lookup + group pipeline.                                                                                                                                                                                                  |
| `workload-agg2.js`              | `sample_airbnb` | Reviews unwind + seasonal rollups pipeline.                                                                                                                                                                                                   |
| `workload-mflix.js`             | `sample_mflix`  | Mixed aggregate + find workloads across mflix collections (intentionally includes some heavy shapes).                                                                                                                                         |
| `workload-mflix-fast.js`        | `sample_mflix`  | **Fast, index-only** loop across every mflix collection. Runs for 5 minutes by default and only uses existing indexes (`cast`, `cast+runtime`, `genres`, `rated`, `runtime`, `email`, `user_id`, `location.geo` 2dsphere, `_id`, text index). |


### Usage

```bash
# Run the orchestrator (executes all workload scripts in parallel)
node scripts/workload.js          # default 10 iterations each
node scripts/workload.js 5        # 5 base iterations each

# Run a single workload
node scripts/workload-agg.js
node scripts/workload-agg2.js
node scripts/workload-mflix.js
node scripts/workload-mflix.js 3  # single pipeline (1-indexed) from the mflix list

# Fast, index-only mflix loop (5 minutes by default)
node scripts/workload-mflix-fast.js
DURATION_MS=60000 node scripts/workload-mflix-fast.js   # 1 minute
```

### Workload connection string

**Two-cluster setup:** `npm start` always uses `**MONGO_URI`** → MongoAdvisor **application** database (`mongoadvisor`). **Monitored** clusters are separate: you register each URI in the **UI** (stored encrypted in `clusters`). For **local workload scripts** only, if sample data is on another host than the app DB, set `**WORKLOAD_MONGO_URI`** in `.env` to that cluster’s connection string; the scripts use `resolveWorkloadMongoUri()` in `[scripts/workload-uri.js](scripts/workload-uri.js)` (`WORKLOAD_MONGO_URI` if set, otherwise `MONGO_URI`).

If the app DB cluster **also** has `sample_airbnb` / `sample_mflix`, you can omit `WORKLOAD_MONGO_URI` and point `MONGO_URI` at a user that can read both `mongoadvisor` and the sample DBs (see bootstrap `readAnyDatabase` note in [step 1 — backend application user](#1-create-the-backend-application-user-scram)).

### Useful environment variables


| Variable                                                        | Script(s)                                        | Purpose                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `WORKLOAD_MONGO_URI`                                            | `workload-*.js`, `airbnb-expand-listings-big.js` | Optional; overrides `MONGO_URI` for those scripts when sample data is on another cluster. |
| `READ_PREF`                                                     | all                                              | Force `primary` or `secondary`; randomized per run otherwise.                             |
| `DURATION_MS`                                                   | `workload-mflix-fast.js`                         | Total run time in ms (default `300000`).                                                  |
| `MIN_SLEEP_MS` / `MAX_SLEEP_MS`                                 | `workload-mflix-fast.js`                         | Jitter between ops (defaults `80` / `350`).                                               |
| `MAX_TIME_MS`                                                   | `workload-mflix-fast.js`                         | Per-query `maxTimeMS` cap (default `5000`).                                               |
| `MFLIX_EMBEDDED_CAP` / `MFLIX_LOOKUP_CAP` / `MFLIX_OUTLIER_CAP` | `workload-mflix.js`                              | Shrink pipeline working sets to keep latency reasonable on small clusters.                |
| `AIRBNB_SEASON_CAP`                                             | `workload-agg2.js`                               | Cap listings processed before `$unwind: $reviews`.                                        |


The fast mflix loop uses a distinct `appName` per query template (for example `workload-mflix-fast-em-cast`, `workload-mflix-fast-theaters-near`, `workload-mflix-fast-movies-text`), so each index-backed shape shows up as its own entry in the dashboard’s per-app charts.

## Security — credential encryption

Source cluster URIs and Atlas private API keys are **encrypted at rest** (AES-256-GCM) before storage in the backend database.


| Layer                | `uri`                         | `atlasPrivateKey`     |
| -------------------- | ----------------------------- | --------------------- |
| `POST /api/clusters` | Plain text in request         | Plain text in request |
| Database             | `iv:authTag:ciphertext` (hex) | Same format           |
| `GET /api/clusters`  | Masked                        | Partially masked      |


- **Key**: 256-bit hex in `ENCRYPTION_KEY` (never commit `.env`)
- **Per-value IV**: random 12 bytes per encrypt
- Rotating `ENCRYPTION_KEY` requires re-encrypting stored values

## Roadmap

1. **Data retention: purge vs. aggregate.** Keep recent metrics hot in the app DB and roll up older metrics; long-term history pushed to S3, Datadog, or similar. Retention windows still to be defined.
2. **Poll delta vs. full for read and write.** Apply timestamp filtering dynamically on `$queryStats` reads (writes can't be made delta-based); expand `$queryStats` analytics with richer aggregations.
3. **Safety rails.** Pause metadata-scanning pollers (indexes, storage) when a cluster looks risky to sweep — e.g. very high collection/index counts — to avoid hammering shared infrastructure.
4. **More indexes.** Add indexes for any new access patterns introduced by future dashboards and API endpoints.
5. **Sharded cluster support.** Currently only replica sets are covered end-to-end.
6. Integration: next.js currently expression.js 5
7. Test mongo7
8. executionstats remvoe PROD
9. title in French

