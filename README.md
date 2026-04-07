# MongoMonitor

Observability tool for MongoDB clusters. Collects query statistics and slow query logs from one or more MongoDB Atlas clusters, stores them in a central backend cluster, and visualises performance analytics in a browser dashboard.

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

The dashboard is at `http://localhost:3000`.

## Configuration

| Variable | Description |
|---|---|
| `MONGO_URI` | Connection string for the MongoMonitor backend cluster |
| `MONGO_DB` | Database name (default: `mongomonitor`) |
| `PORT` | HTTP port (default: `3000`) |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored credentials |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Architecture

```
┌────────────────────────────┐       ┌───────────────────────────────┐
│  Source MongoDB Cluster(s)  │       │   MongoMonitor Backend (M10)  │
│  ┌─────┐ ┌─────┐ ┌─────┐  │       │                               │
│  │ P   │ │ S   │ │ S   │◄─┼───────┤  collector.js                 │
│  └─────┘ └─────┘ └─────┘  │       │   ├─ $queryStats per node     │
└────────────────────────────┘       │   ├─ Atlas Logs API per node  │
       ▲                             │   └─ db.hello() topology      │
       │  Atlas Admin API            │                               │
       └─────────────────────────────┤  Collections:                 │
                                     │   ├─ clusters                 │
                                     │   ├─ topologies               │
                                     │   ├─ query_stats              │
                                     │   └─ slow_queries             │
                                     │                               │
                                     │  Express API (:3000)          │
                                     │   └─ public/ dashboard        │
                                     └───────────────────────────────┘
```

## Data Collection

MongoMonitor runs two embedded pollers on configurable intervals:

| Collector | Interval | Source | What it stores |
|---|---|---|---|
| `$queryStats` | 5 min | Each replica set member via `directConnection` | Exec count, total/avg latency, docs/keys examined, query shape, appName, comment, **host** |
| Atlas Logs API | 10 min | `/performanceAdvisor/slowQueryLogs` per host | cpuNanos, bytesRead, timeReadingMicros, millis, docsExamined, keysExamined, appName, comment, **host** |
| Topology | 5 min | `db.hello()` | Replica set members, primary, set name |

Queries from internal agents (`MongoDB Automation Agent`, `MongoDB Monitoring Module`) are filtered at ingestion.

## Dashboard

The frontend (`public/`) is a single-page app using Chart.js. It provides:

- **Exec Count by appName** — bar chart from `$queryStats`
- **Total Execution Time by appName** — bar chart from `$queryStats`
- **Slowest Queries by appName** — average latency ranking
- **Query Stats Timeline** — delta-based bar+line chart showing new executions and docs examined between snapshots
- **IO Heatmap** — treemap sized by slow query count, coloured by bytes read intensity (from Atlas Logs)
- **CPU Heatmap** — treemap sized by slow query count, coloured by cpuNanos intensity (from Atlas Logs)
- **Slow Queries list** — individual slow query log entries with details

### Filters

All charts respond to three filters:

| Filter | Description |
|---|---|
| **Time range** | 1h, 6h, 24h, 7d, 30d |
| **Nodes** | Checkbox per replica set member — select/deselect individual hosts |
| **Namespaces** | Checkbox per `db.collection` — system and `mongomonitor` databases hidden by default |

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Backend connectivity check |
| `GET` | `/api/clusters` | List registered source clusters (credentials masked) |
| `POST` | `/api/clusters` | Register a source cluster |
| `GET` | `/api/clusters/:id` | Get a single cluster |
| `DELETE` | `/api/clusters/:id` | Remove a cluster |
| `GET` | `/api/topologies` | All discovered topologies |
| `POST` | `/api/topologies/:id/discover` | Trigger topology refresh |
| `GET` | `/api/metrics/app-load` | Aggregated exec count/time by appName |
| `GET` | `/api/metrics/query-stats` | Raw `$queryStats` snapshots |
| `GET` | `/api/metrics/heatmap` | IO/CPU heatmap data grouped by appName + comment |
| `GET` | `/api/metrics/slow-queries` | Individual slow query log entries |
| `GET` | `/api/metrics/hosts` | Distinct hosts from topology |
| `GET` | `/api/metrics/namespaces` | Distinct namespaces from query stats |

Query parameters: `since` (ISO date), `namespace` (repeatable), `host` (repeatable), `clusterId`.

## Project Structure

```
src/
├── server.js          # Express entry point
├── db.js              # MongoDB backend connection (pooled, single client)
├── crypto.js          # AES-256-GCM encryption for stored credentials
├── collector.js       # $queryStats + Atlas Logs API pollers
├── discovery.js       # Replica set topology discovery via db.hello()
├── pool-cache.js      # Persistent connection pool cache (replica set + direct per-host)
└── routes/
    ├── health.js      # Health check
    ├── clusters.js    # Cluster CRUD (credentials masked in responses)
    ├── topologies.js  # Topology endpoints
    └── metrics.js     # Analytics query endpoints

public/
├── index.html         # Dashboard shell
├── app.js             # Chart rendering and filter logic
└── style.css          # Dark-theme styles

scripts/
├── workload.js        # Orchestrator — runs all workloads in parallel with random read preference
├── workload-agg.js    # Airbnb 10-stage analytics pipeline
├── workload-agg2.js   # Airbnb seasonal pricing pipeline
└── workload-mflix.js  # Mflix 7 heavy aggregation pipelines
```

## Workload Generation

Scripts in `scripts/` generate test load against sample datasets (`sample_airbnb`, `sample_mflix`). Each run randomly targets `primary` or `secondary` read preference to distribute load across all nodes.

```bash
node scripts/workload.js          # Run all workloads (default 10 iterations each)
node scripts/workload.js 5        # Run with 5 base iterations
node scripts/workload-agg.js      # Airbnb analytics only
node scripts/workload-agg2.js     # Airbnb seasonal pricing only
node scripts/workload-mflix.js    # All 7 mflix pipelines
node scripts/workload-mflix.js 3  # Run a single mflix pipeline by number
```

Each script sets `appName` and `comment` on connections/queries for traceability in Atlas logs, `$queryStats`, and `db.currentOp()`.

## Security — Credential Encryption

Source cluster connection strings and Atlas API private keys are **encrypted at rest** using AES-256-GCM before being stored in the backend database.

| Layer | `uri` field | `atlasPrivateKey` field |
|---|---|---|
| API request (`POST /api/clusters`) | Plain text | Plain text |
| Database (at rest) | `iv:authTag:ciphertext` (hex) | `iv:authTag:ciphertext` (hex) |
| API response (`GET /api/clusters`) | Password masked (`••••••`) | Key partially masked (`sraw••••e6f`) |

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: 256-bit, stored as 64-char hex in `ENCRYPTION_KEY` (`.env`, gitignored)
- **Per-value IV**: Random 12-byte IV per encryption — identical values produce different ciphertext
- Rotating the key requires re-encrypting all stored credentials
