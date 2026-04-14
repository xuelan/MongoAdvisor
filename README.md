# MongoAdvisor

MongoAdvisor rethinks MongoDB observability. Instead of yet another raw metrics or cluster check tool, it continuously analyzes your clusters and delivers actionable recommendations with direct links to the exact playbook you need — turning insight into action in seconds, not hours, not days. So you can keep innovating and scaling.
 
Currently the tool supports Replica Sets, Sharded cluster will be added in the future.


Collects `$queryStats`, index metadata, storage metrics, disk usage, and oplog window information from registered clusters; optionally enriches with **Atlas Performance Advisor** slow-query logs when Atlas API keys are supplied. All telemetry is stored in a central MongoDB database and shown in a browser dashboard.

## Bootstrap (Atlas)

Use this sequence for a **new** deployment. You need **two different programmatic API key pairs**:

| Key | Typical Atlas roles | Used for |
|-----|---------------------|----------|
| **Bootstrap / admin key** | Enough privilege to **create database users** on a project (e.g. **Project Owner** or **Project Database Access Admin**) | `npm run atlas:create-user` (steps 1 and 3), or `POST /api/atlas/database-users` / `POST /api/clusters/:id/atlas-database-users` |
| **Monitoring key** | **Project Read Only** + **Project Data Access Read Only** → API values `GROUP_READ_ONLY`, `GROUP_DATA_ACCESS_READ_ONLY` | Stored in MongoAdvisor per cluster for **Performance Advisor** slow-query logs (`collector.js`) |

Create the bootstrap key in Atlas **Access Manager** if you do not already have one. The monitoring key is created in step 2 and is **not** the same as the bootstrap key (read-only keys cannot create users).

**Prerequisites:** `npm install` in this repo; Atlas **project IDs** for the backend cluster project and each monitored workload project; backend Atlas cluster reachable for `MONGO_URI`.

### 1. Create the backend application user (SCRAM)

Creates `readWrite` on database `mongoadvisor` with SCRAM auth against **`admin`** (Atlas requirement). Pass the **bootstrap** public/private keys (not the monitoring key).

```bash
# databaseName (auth): admin | roles: readWrite @ mongoadvisor
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset backend \
  --project-id "<BACKEND_ATLAS_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username mongoadvisor_app
```

Optional: `--cluster-name "<backend Atlas cluster name>"` scopes the user to one cluster.

Alternatives: Atlas UI **Database Access**, or the HTTP API documented under [Atlas database users (CLI and HTTP API)](#atlas-database-users-cli-and-http-api) (same payloads as `npm run atlas:create-user`).

Example **`MONGO_URI`**: `mongodb+srv://mongoadvisor_app:<password>@<host>/mongoadvisor?authSource=admin`

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

Collector connects with this **MongoDB** user (`metrics_reader` pattern). Use **`--preset metrics`** on the **monitored** project; `--cluster-name` must match the **Atlas cluster name**.

```bash
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset metrics \
  --project-id "<MONITORED_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username metrics_reader \
  --cluster-name "<Atlas cluster name>"
```

Omit `--cluster-name` only if you intentionally want a project-wide database user. Example connection string: `mongodb+srv://metrics_reader:<password>@<host>/?authSource=admin`

### 4. Configure environment variables

Do **not** commit secrets. Locally, copy `.env.example` to `.env`. In production, set the same variable **names** via your platform (Kubernetes secrets, PaaS env, systemd, etc.):

| Variable | Purpose |
|----------|---------|
| `MONGO_URI` | From step 1 (`authSource=admin` on Atlas) |
| `MONGO_DB` | Application database name (default `mongoadvisor`) |
| `ENCRYPTION_KEY` | 64 hex chars — encrypts stored cluster URIs and Atlas private keys in the app DB |
| `PORT` | Optional (default `3000`) |

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

| Variable | Description |
|---|---|
| `MONGO_URI` | Connection string for the **MongoAdvisor backend** database (stores clusters, metrics, encrypted secrets) |
| `MONGO_DB` | Database name on that cluster (default: `mongoadvisor`) |
| `PORT` | HTTP port (default: `3000`) |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored credentials |

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

This user must **read and write** the MongoAdvisor application database (default `mongoadvisor`). Effective access is **`readWrite` on `mongoadvisor`**. On **Atlas**, SCRAM users must use the **`admin`** authentication database (`DATABASE_NAME_INVALID_ADMIN` if you use another auth DB); **`--preset backend`** sets Atlas `databaseName` to **`admin`** and keeps the role on **`mongoadvisor`**. On **self-managed** MongoDB you can still create the user with auth DB `mongoadvisor` if you prefer.

Create the user on Atlas with the Administration API (Digest auth). Use the **bootstrap** API key pair (must be allowed to create database users), not the read-only monitoring key from bootstrap step 2:

```bash
# No --role flag: --preset backend sends these to Atlas (SCRAM):
#   databaseName (auth): admin   ← required on Atlas
#   roles: readWrite @ mongoadvisor
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset backend \
  --project-id "<Atlas project ID>" \
  --public-key "<Atlas API public key>" \
  --private-key "<Atlas API private key>" \
  --username mongoadvisor_app
```

On self-managed hosts, `db.createUser({ user, pwd, roles: [{ role: "readWrite", db: "mongoadvisor" }] })` in the `mongoadvisor` database is equivalent access; this repo’s API maps **`--preset backend`** to the Atlas-safe payload above.

Optional: `--cluster-name "<Atlas cluster name>"` scopes the user to a single cluster in the project.

Example **`MONGO_URI`** after creation on Atlas: `mongodb+srv://mongoadvisor_app:<password>@<host>/mongoadvisor?authSource=admin`

### 2. Monitored cluster user (connection string per cluster)

The collector runs commands and aggregations against **each registered cluster**. A minimal **built-in** combination that matches the current code paths is:

| Role | Database | Why |
|---|---|---|
| `clusterMonitor` | `admin` | Monitoring commands, `listDatabases`, and `$queryStats` (`queryStatsRead` — see [MongoDB `$queryStats`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)) |
| `readAnyDatabase` | `admin` | `listCollections`, `$indexStats`, `collStats` on user databases |
| `read` | `local` | Read `local.oplog.rs` for oplog window sampling (`readAnyDatabase` does not cover `local`) |

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

SCRAM users are **not** created from the web UI. Use **`npm run atlas:create-user`** (see [Bootstrap (Atlas)](#bootstrap-atlas)) or call the routes below (same presets as `src/atlas-db-users.js`). Optional server env **`ATLAS_BACKEND_PROJECT_ID`** and **`ATLAS_BACKEND_PUBLIC_KEY`** are exposed via **`GET /api/atlas/database-users/defaults`** so scripts or `curl` can prefill non-secrets only (never put a private API key in `.env` for a browser).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/atlas/database-users/presets` | Preset ids and descriptions (`backend`, `metrics`). |
| `GET` | `/api/atlas/database-users/defaults` | JSON `{ projectId, publicKey }` from optional env (non-secrets only). |
| `POST` | `/api/atlas/database-users` | Body: `preset`, `projectId`, `publicKey`, `privateKey`, `username`, `password`, optional `clusterName` (Atlas cluster name for scope). |
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

| Collector | Interval | Source | Stored as |
|---|---|---|---|
| `$queryStats` + topology | 5 min | Each replica member via `directConnection`; `hello` on default connection | `query_stats`, `topologies` |
| Atlas slow query logs | 10 min | Performance Advisor API per host (if keys set) | `slow_queries` |
| `$indexStats` (unused / redundant) | 10 min | Per host / primary | `index_stats` |
| Disk usage (`dbStats` on `admin`) | 10 min | Cluster connection | `disk_usage` |
| Oplog window | 10 min | First/last `ts` on `local.oplog.rs` | `oplog_window` |
| Storage & fragmentation (`collStats`) | Daily ~3:00 local; once on startup if empty | Cluster connection | `storage_stats` |

Queries from internal agents (`MongoDB Automation Agent`, `MongoDB Monitoring Module`) are filtered at ingestion for `$queryStats`.

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

| Filter | Description |
|---|---|
| **Time range** | 5 min, 1 hour, 1 day, 1 week, or all |
| **Nodes** | One checkbox per replica set member (from topology) |
| **Namespaces** | `db.collection`; system DBs including `mongoadvisor` and legacy `mongomonitor` hidden from the picker (see `src/hidden-dbs.js`) |

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Ping application database |
| `GET` | `/api/clusters` | List clusters (secrets masked) |
| `POST` | `/api/clusters` | Register a cluster |
| `GET` | `/api/clusters/:id` | One cluster |
| `PATCH` | `/api/clusters/:id` | Update cluster (`name`, `region`, `uri`, Atlas fields; omit `uri` / `atlasPrivateKey` to leave unchanged) |
| `DELETE` | `/api/clusters/:id` | Remove cluster |
| `POST` | `/api/clusters/:id/atlas-database-users` | Create Atlas SCRAM user using stored cluster Atlas API keys |
| `GET` | `/api/atlas/database-users/presets` | Preset ids for Atlas SCRAM user creation |
| `GET` | `/api/atlas/database-users/defaults` | Optional `{ projectId, publicKey }` from server env (for scripts / `curl`) |
| `POST` | `/api/atlas/database-users` | Create Atlas SCRAM user (credentials in JSON body) |
| `GET` | `/api/topologies` | All topologies |
| `POST` | `/api/topologies/:id/discover` | Refresh topology |
| `GET` | `/api/metrics/namespaces` | Distinct namespaces for filters |
| `GET` | `/api/metrics/hosts` | Distinct hosts from topology |
| `GET` | `/api/metrics/app-load` | Aggregated load by appName |
| `GET` | `/api/metrics/query-stats` | Raw `$queryStats`-backed snapshots |
| `GET` | `/api/metrics/app-analysis` | App-level analysis aggregates |
| `GET` | `/api/metrics/impact-by-query` | Per-query impact metrics |
| `GET` | `/api/metrics/heatmap` | Heatmap payload (IO/CPU grouping) |
| `GET` | `/api/metrics/bubble` | Bubble chart payload |
| `GET` | `/api/metrics/slow-queries` | Slow query log documents |
| `GET` | `/api/metrics/unused-indexes` | Unused index rows |
| `GET` | `/api/metrics/redundant-indexes` | Redundant index rows |
| `GET` | `/api/metrics/storage` | Storage / fragmentation rows |
| `GET` | `/api/metrics/disk-usage` | Latest disk usage per cluster |
| `GET` | `/api/metrics/oplog-window` | Latest oplog window per cluster |
| `GET` | `/api/metrics/monitor-logs` | Collector/API audit (`?limit=`, `?since=`, `?clusterId=`, `?action=`, `?outcome=`) |

Common query parameters: `since` (ISO date), `namespace` (repeatable), `host` (repeatable), `clusterId`.

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
├── workload.js        # Runs all workloads (random read preference)
├── workload-agg.js    # sample_airbnb analytics pipeline
├── workload-agg2.js   # sample_airbnb seasonal pipeline
└── workload-mflix.js  # sample_mflix aggregations
```

## Workload generation

Scripts target sample datasets (`sample_airbnb`, `sample_mflix`). Each run randomly uses `primary` or `secondary` read preference when possible.

```bash
node scripts/workload.js          # All workloads (default 10 iterations each)
node scripts/workload.js 5        # 5 base iterations
node scripts/workload-agg.js
node scripts/workload-agg2.js
node scripts/workload-mflix.js
node scripts/workload-mflix.js 3  # Single pipeline by index
```

Connections set `appName` and `comment` for traceability in Atlas logs and `$queryStats`.

## Security — credential encryption

Source cluster URIs and Atlas private API keys are **encrypted at rest** (AES-256-GCM) before storage in the backend database.

| Layer | `uri` | `atlasPrivateKey` |
|---|---|---|
| `POST /api/clusters` | Plain text in request | Plain text in request |
| Database | `iv:authTag:ciphertext` (hex) | Same format |
| `GET /api/clusters` | Masked | Partially masked |

- **Key**: 256-bit hex in `ENCRYPTION_KEY` (never commit `.env`)
- **Per-value IV**: random 12 bytes per encrypt
- Rotating `ENCRYPTION_KEY` requires re-encrypting stored values



## TODO List

1. Data purging VS Aggregation
- We will only store recent metrics, and aggregation of old metrics, period to be defined.
- The whole history should be stored in S3 or Datadog etc

2. Poll delta VS full
- Apply timestamp dynamically on $queryStats

2. Add security check
- In case of any risk cases, we will stop polling, e.g. massive number of collections and indexes, it could be risky to scan all the metadata for index and storage etc

3. Add indexes