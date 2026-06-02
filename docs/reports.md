# Cluster Reports (offline analysis)

In addition to the live dashboard, MongoAdvisor can analyze a snapshot
collected with [`getMongoData.js`](https://github.com/mongodb/support-tools/tree/master/getMongoData)
and produce a human-readable report. Use this when:

- You don't have MongoDB network connectivity from the MongoAdvisor host
  (firewall, air-gapped, support engagement, customer-shared dump).
- You want a one-shot, file-based record you can email / attach to a
  ticket alongside its `getMongoData.log`.

Eight production-readiness checks run per node and are aggregated by
replica-set name. See [What's checked](#whats-checked) below.

## Workflow

1. On each replica-set member, run:

   ```bash
   mongo "mongodb://USER:PASS@HOST:PORT/admin" getMongoData.js > getMongoData-<host>.log
   ```

   For a sharded cluster, run it against any **mongos** (the script auto-
   detects and adds `shard_info`).

2. Open `http://localhost:3000/report.html` (or the **Reports** pill in
   the dashboard header).

3. Drag each `.log` (it's actually JSON) into the upload zone, optionally
   set a report name, and click **Generate report**.

4. The new report opens at `/report.html?id=<reportId>`. Use **Download
   HTML** to save a self-contained file you can share — no server
   needed to open it.

## What's checked

The source of truth for thresholds lives in
[`src/report/checks/thresholds.js`](../src/report/checks/thresholds.js).

| Item               | What we look at                                                                       | Default threshold                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BuildInfoItem`    | `server_status.version` / `server_build_info.version`                                 | `eol_version: [4, 4, 0]` — anything older is HIGH.                                                                                                                                             |
| `SecurityItem`     | `command_line_info.parsed.security`, `…parsed.net.tls`, `server_parameters`           | Boolean: auth enabled, TLS = `requireTLS`, server-side JS disabled, `enableLocalhostAuthBypass` off.                                                                                           |
| `HostInfoItem`     | `server_info.host_info` (`system.memSizeMB`, `system.numaEnabled`, `extra.maxOpenFiles`) | RAM ≥ 8 GB; NUMA pinned; `ulimit -n` ≥ 64 000.                                                                                                                                                  |
| `ServerStatusItem` | `serverStatus.connections`, `metrics.queryExecutor`, `metrics.document`, `wiredTiger.cache` | `used_connection_ratio: 0.8`, `query_targeting: 1000`, `query_targeting_obj: 1000`, `cache_read_into_mb: 100`.                                                                                  |
| `ClusterItem`      | `rs.status()` member states + `db.getReplicationInfo().timeDiffHours`                 | `replication_lag_seconds: 0`, `oplog_window_hours: 48`.                                                                                                                                        |
| `CollInfoItem`     | per-collection `stats.{avgObjSize,storageSize,totalIndexSize}` + `wiredTiger["block-manager"]["file bytes available for reuse"]` | `obj_size_kb: 32`, `collection_size_gb: 2048`, `fragmentation_ratio: 0.5`, `index_size_ratio: 0.2`, `ops_latency_ms: 100`. |
| `IndexInfoItem`    | per-collection `$indexStats` + index list                                             | `unused_index_days: 7`, `num_indexes: 10`. Redundancy (prefix-of) is always emitted.                                                                                                            |
| `ShardKeyItem`     | `shard_info` (only present when getMongoData was run against a mongos)                | `sharding_imbalance_percentage: 0.1`.                                                                                                                                                          |

Each finding has a `severity` (`HIGH`, `MEDIUM`, `LOW`, `INFO`), a
`host`, a `title`, and a `description`. Where the remediation is
mechanical, findings also carry an `actions[]` array with copy‑ready
mongosh snippets — currently:

- `compact` (fragmented collection)
- `hideIndex` + `dropIndex` (redundant or unused index) — with a bulk
  "Copy hide-all / drop-all script" button at the group header
- `resizeOplog` + `minRetention` (oplog window below threshold)
- `systemd` (low `ulimit -n`)

The UI groups findings by check (`Cluster`, `Collections`, `Indexes`,
`Security`, etc.); each group shows a per-severity pill summary and is
ordered by the worst severity it contains.

## Limits and trade-offs

- **Per-file size cap:** 14 MB pre-parse (override with
  `REPORT_MAX_FILE_MB`). Larger captures should be split per replica-set
  member.
- **Max files per upload:** 20 (override with `REPORT_MAX_FILES`).
- **Per-report threshold overrides via UI:** out of scope for v1.
  Adjust [`src/report/checks/thresholds.js`](../src/report/checks/thresholds.js)
  and restart.
- **Sharded-cluster shard-level analysis:** v1 reads `shard_info` when
  uploaded alongside a mongos capture and surfaces chunk-imbalance
  findings via `ShardKeyItem`. Per-shard `CollInfo` analysis requires
  uploading one capture per shard's PRIMARY.

## Storage

Two new collections in the MongoAdvisor app DB
([`scripts/ensure-indexes.js`](../scripts/ensure-indexes.js) creates the
indexes):

- `reports` — one document per logical report (normalized payload +
  findings + summary). Listed at `GET /api/reports`.
- `reports_raw` — one document per uploaded file, keyed by `reportId`,
  preserving the original EJSON in case you want to re-render later.

Deleting a report (`DELETE /api/reports/:id` or the **Delete** button)
also drops its raw rows.

## The downloadable HTML

`GET /api/reports/:id/download.html` returns a single
self-contained `.html`:

- The page's CSS ([`public/style.css`](../public/style.css)) and JS
  ([`public/report.js`](../public/report.js)) are inlined.
- The Chart.js CDN tag is **stripped** — the embedded JS detects
  `window.Chart === undefined` and falls back to an inline-SVG renderer
  (similar bars / doughnut, simpler axes, no dependency).
- The report JSON is embedded in
  `<script type="application/json" id="reportData">…</script>`.
- Heavy WiredTiger counters are slimmed out of the embedded payload
  (the full raw EJSON stays in `reports_raw` on the server). A 161-
  collection capture downloads as ~370 KB.
- Per-collection WiredTiger cache for the **Collections** tab pie chart
  (`wiredTiger.cache."bytes currently in the cache"`) is kept in the embed;
  if the stored report is missing it, download backfills from `reports_raw`
  before slimming.

Open the file directly from disk — no network, no server.
