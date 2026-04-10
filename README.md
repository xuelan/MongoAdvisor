# MongoMonitor

MongoMonitor rethinks MongoDB observability. Instead of yet another raw metrics or cluster check tool, it continuously analyzes your clusters and delivers actionable recommendations with direct links to the exact playbook you need — turning insight into action in seconds, not hours, not days. So you can keep innovating and scaling.
 
Currently the tool supports Replica Sets, Sharded cluster will be added in the future.


Collects `$queryStats`, index metadata, storage metrics, disk usage, and oplog window information from registered clusters; optionally enriches with **Atlas Performance Advisor** slow-query logs when Atlas API keys are supplied. All telemetry is stored in a central MongoDB database and shown in a browser dashboard.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your MongoDB connection string and generate an encryption key

# Start the server
npm start

# Or with auto-reload during development
npm run dev
```

The dashboard is at `http://localhost:3000`. If the application database is unreachable, a banner explains the issue; the header badge still reflects `/api/health`.

## Configuration

| Variable | Description |
|---|---|
| `MONGO_URI` | Connection string for the **MongoMonitor backend** database (stores clusters, metrics, encrypted secrets) |
| `MONGO_DB` | Database name on that cluster (default: `mongomonitor`) |
| `PORT` | HTTP port (default: `3000`) |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored credentials |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## MongoDB users and roles

You need **two different identities**: one for the app’s own database, and one (per monitored cluster) embedded in each connection string you register in the UI.

### 1. Backend application user (`MONGO_URI`)

This user must **read and write** the MongoMonitor database (default `mongomonitor`). Example:

```javascript
use mongomonitor

db.createUser({
  user: "mongomonitor_app",
  pwd: "<strong-password>",
  roles: [{ role: "readWrite", db: "mongomonitor" }],
})
```

Example URI: `mongodb+srv://mongomonitor_app:<password>@<host>/mongomonitor?authSource=mongomonitor` (or `authSource=admin` if the user was created on `admin`).

### 2. Monitored cluster user (connection string per cluster)

The collector runs commands and aggregations against **each registered cluster**. A minimal **built-in** combination that matches the current code paths is:

| Role | Database | Why |
|---|---|---|
| `clusterMonitor` | `admin` | Monitoring commands, `listDatabases`, and `$queryStats` (`queryStatsRead` — see [MongoDB `$queryStats`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/)) |
| `readAnyDatabase` | `admin` | `listCollections`, `$indexStats`, `collStats` on user databases |
| `read` | `local` | Read `local.oplog.rs` for oplog window sampling (`readAnyDatabase` does not cover `local`) |

Example (run on `admin`):

```javascript
use admin

db.createUser({
  user: "mongomonitor",
  pwd: "<strong-password>",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "readAnyDatabase", db: "admin" },
    { role: "read", db: "local" },
  ],
})
```

Example URI: `mongodb+srv://mongomonitor:<password>@<host>/?authSource=admin`.

**Atlas notes:** Slow-query log ingestion uses the **Atlas Admin API** (project ID + API keys in the form), not the database user. `$queryStats` may require a sufficient Atlas tier and MongoDB version; see MongoDB documentation for your deployment.

## Architecture

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ Source MongoDB cluster(s)  │       │ MongoMonitor backend DB    │
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
                                     │ oplog_window               │
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

- **Monitored clusters** — register URIs and optional Atlas API fields; topology with refresh
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
| **Namespaces** | `db.collection`; system DBs and `mongomonitor` hidden by default |

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Ping application database |
| `GET` | `/api/clusters` | List clusters (secrets masked) |
| `POST` | `/api/clusters` | Register a cluster |
| `GET` | `/api/clusters/:id` | One cluster |
| `DELETE` | `/api/clusters/:id` | Remove cluster |
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

Common query parameters: `since` (ISO date), `namespace` (repeatable), `host` (repeatable), `clusterId`.

## Project structure

```
src/
├── server.js          # Express entry point
├── db.js              # Backend MongoDB client (MONGO_URI / MONGO_DB)
├── crypto.js          # AES-256-GCM for stored credentials
├── collector.js       # Pollers ($queryStats, logs, indexes, storage, disk, oplog)
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
