# Development reference

Project layout, unit tests, and roadmap.

- [Project structure](#project-structure)
- [Unit tests](#unit-tests)
- [Versioning](#versioning)
- [Roadmap](#roadmap)

## Project structure

```
src/
├── server.js          # Express entry point
├── db.js              # Backend MongoDB client (MONGO_URI / MONGO_DB)
├── crypto.js          # AES-256-GCM for stored credentials
├── collector.js       # Pollers ($queryStats, logs, indexes, storage, disk, oplog)
├── retention.js       # TTL setup + hourly rollups (docs/retention.md)
├── monitor-log.js     # Writes `monitor_logs` audit rows (collector + API)
├── discovery.js       # Topology via hello
├── hidden-dbs.js      # System / app DB filter for ingestion + filters
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
├── atlas-create-db-user.js          # npm run atlas:create-user — Atlas SCRAM user via Admin API
├── ensure-indexes.js                # npm run indexes:ensure — app DB indexes (TTL + rollup also created at startup)
├── measure-retention-footprint.js   # read-only sizing report (see docs/retention.md)
├── decrypt-field.js                 # npm run decrypt:field — decrypt stored uri / atlasPrivateKey (ENCRYPTION_KEY from .env)
├── update-cluster-uri.js            # rewrite a stored cluster URI directly (restart server afterwards)
├── workload-uri.js                  # resolve WORKLOAD_MONGO_URI || MONGO_URI for workload scripts
├── airbnb-expand-listings-big.js    # build sample_airbnb.listingsAndReviews_big from listingsAndReviews ($range + $unwind)
├── workload.js                      # Orchestrator (subprocess-per-iteration; for heavy aggregations)
├── workload-fast.js                 # Orchestrator (N parallel long-running fast workers, mflix + agg mix)
├── workload-fast-agg.js             # Fast index-backed aggregations on listingsAndReviews_big + mflix
├── workload-agg.js                  # sample_airbnb analytics pipeline (heavy)
├── workload-agg2.js                 # sample_airbnb seasonal pipeline (heavy)
├── workload-mflix.js                # sample_mflix mixed aggregate + find workloads
└── workload-mflix-fast.js           # sample_mflix fast, index-only find loop (default 5 min)
```

See [docs/workloads.md](workloads.md) for a per-workload-script breakdown.

## Unit tests

The suite uses the built-in
`[node --test](https://nodejs.org/api/test.html)` runner — **no extra dev
dependencies**. Tests live in `[tests/](../tests/)` and are pure unit tests
(no MongoDB connection required); they cover the read-path pipeline
builders, the rollup delta-fold, the `$queryStats` version gate, the
credential encryption helpers, and the hidden-DB filter.

```bash
npm test                                     # runs all tests
node --test tests/metrics-pipeline.test.js   # one suite at a time
```


| File                                   | What it covers                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/metrics-pipeline.test.js`       | `buildQueryStatsPipelinePrefix` / `buildSlowQueriesPipelinePrefix` for the three time-filter cases (hot only, hybrid, **All**), plus the rollup → raw alias projection. |
| `tests/retention-delta-fold.test.js`   | `sumPositiveDeltas` — monotonic growth, counter resets, repeated resets, non-numeric inputs, idle values; `floorToHour` and `addHours` arithmetic.                      |
| `tests/discovery-version-gate.test.js` | `supportsQueryStats` truth table for 6.x / 7.0 / 7.1 / 7.2 / 8.x and invalid / missing version arrays.                                                                  |
| `tests/crypto.test.js`                 | AES-256-GCM encrypt + decrypt round-trip, `iv:tag:ciphertext` format, IV randomness, tamper rejection, format-validation rejection. `isEncrypted` truth table.          |
| `tests/hidden-dbs.test.js`             | `isHiddenTopLevelDb` for system DBs, the app DB, the MCP scratch DB, workload DBs, case sensitivity, and null/undefined safety.                                         |


The suite is fast (sub-second on a laptop) and runs without a network — it's
safe to wire into a pre-commit hook or CI.

**Currently uncovered** (good follow-up areas):
`[src/collector.js](../src/collector.js)` (timestamp parsing, dedupe keys,
queryStats hashing), `[src/server.js](../src/server.js)` HTTP handlers
(would need supertest + a fake `db` module), Atlas Performance Advisor
parsing, `[scripts/*](../scripts)` orchestration. These all involve I/O so
they need either dependency injection or an integration-test setup.

## Versioning

| Label | Meaning |
| ----- | ------- |
| **`0.1.x-beta`** | Public beta — feature-complete enough to try; breaking changes and missing auth expected. |
| **`0.2.0`** (planned) | Target for dashboard/API authentication and baseline security hardening. |
| **`1.0.0`** (future) | Stable API and production-oriented deployment story. |

Release tags on GitHub should match `package.json` (e.g. `v0.1.0-beta`).

## Roadmap

Beta releases follow **`0.1.x-beta`** semver until authentication and core
security hardening ship; then the project will move toward **`0.2.0`**.

1. **Dashboard & API authentication.** Login for the UI and REST API (session or
   token-based), optional RBAC, and safe defaults when binding beyond localhost.
2. **Security hardening.** Audit surface area (CORS, cluster registration,
   Atlas key handling), `SECURITY.md` reporting path, dependency scanning in CI,
   and deployment guidance (TLS termination, network isolation, secrets management).
3. **Poll delta vs. full for read and write.** Apply timestamp filtering
  dynamically on `$queryStats` reads (writes can't be made delta-based);
   expand `$queryStats` analytics with richer aggregations.
4. **More indexes.** Add indexes for any new access patterns introduced by
  future dashboards and API endpoints.
5. **Sharded cluster support.** Currently only replica sets are covered
  end-to-end — Atlas `mongos` processes are filtered out by the collector.
6. **Integration tests**
7. **Report recommendations** — expand offline audit output and actionable fixes.

