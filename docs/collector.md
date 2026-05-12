# Collector reference

How MongoAdvisor gathers data from each monitored cluster, what it writes, how
the dedupe + timestamp logic works, and which indexes back each access pattern.

For retention / rollup of the collections written here, see
[retention.md](retention.md).

## Overview — what runs, when, and where it lands

Embedded pollers live in [`src/collector.js`](../src/collector.js). All
collectors run on fixed intervals after an initial bootstrap pass that fills in
topology before per-host collectors fire.

| Collector | Interval | Source | Stored as |
| --- | --- | --- | --- |
| Topology discovery | 5 min + on URI change + manual `Refresh` | `hello`, `serverStatus.catalogStats`, `listDatabases`; SRV resolution of the URI hostname | `topologies` |
| `$queryStats` | 5 min | Each replica member via `directConnection` | `query_stats` |
| Atlas slow query logs | 5 min | Performance Advisor API per Atlas process (if keys set); per‑host **watermark** sizes the request window | `slow_queries` |
| `$indexStats` (unused / redundant) | 10 min | Per host / primary | `index_stats` |
| Disk usage (`dbStats` on `admin`) | 5 min | Cluster connection | `disk_usage` |
| Oplog window | 5 min | First/last `ts` on `local.oplog.rs` | `oplog_window` |
| Storage & fragmentation (`collStats`) | Daily ~3:00 local; once on startup; on cluster create | Cluster connection | `storage_stats` |

On startup, **all collectors** (including storage) run once after the initial
topology discovery so per-host queries see a populated `topologies` document;
the periodic timers start after that initial pass completes. When a new cluster
is registered via `POST /api/clusters`, discovery + a one-shot `$queryStats` +
storage pass run for that cluster so the dashboard fills in immediately.

Queries from internal agents (`MongoDB Automation Agent`,
`MongoDB Monitoring Module`) and from the MongoAdvisor app itself
(`appName: "mongoadvisor"`) are filtered at ingestion. System DBs (`admin`,
`config`, `local`, `mongoadvisor`, `#mongodb-mcp`) are dropped from
`query_stats` and `slow_queries` ingestion (see
[`src/hidden-dbs.js`](../src/hidden-dbs.js)).

## Topology discovery and Atlas DNS aliases

`hello` returns the **internal replica set member names** (e.g.
`atlas-xxxxxx-shard-00-01.mongodb.net`). When a single Atlas project has
multiple cluster DNS aliases that point at the same physical replica set,
`hello.hosts` looks identical for both — that is misleading in the UI and
breaks per-cluster filtering.

Discovery handles this by resolving the SRV record from the URI hostname
(`_mongodb._tcp.<cluster-alias>.mongodb.net`) and storing the
**alias-prefixed** hostnames (e.g. `workload-shard-00-01.mongodb.net`) when
they differ from `hello.hosts`. The Performance Advisor `slowQueryLogs`
collector additionally calls Atlas `listGroupProcesses` to use the **correct
Atlas process ID** for each replica member instead of relying on `hello.hosts`.

If `hello` fails (e.g. wrong credentials in the URI) but SRV resolution
succeeds, the topology is still saved with SRV-derived hostnames and
`helloOk: false`. The UI shows a red **⚠ auth failed** badge next to the
topology so the misconfiguration is obvious.

When `hello` succeeds, discovery also runs
`serverStatus({ catalogStats: 1 })` and `listDatabases({ nameOnly: true })`.
The result is stored on the topology document as `catalogStats`, `databases`,
and `catalogTooLarge` (true when `catalogStats.collections > 10_000`). Heavy
per-collection collectors (`storage_stats`, `index_stats`) are skipped for
clusters with `catalogTooLarge: true` and the UI surfaces a **⚠ N collections —
heavy scans skipped** badge with a link to the
[Reduce the Number of Collections](https://www.mongodb.com/docs/manual/data-modeling/design-antipatterns/reduce-collections/#reduce-the-number-of-collections)
anti-pattern doc. The Databases filter (`/api/metrics/databases`) reads from
`topologies.databases`, so even brand-new clusters with no `query_stats` data
yet still show database checkboxes immediately after the first discovery.

## `$queryStats` collector

`collectQueryStats` iterates over `topologies.hosts` and runs
`{ $queryStats: {} }` on each member via `directConnection`. Per host, each
returned entry becomes one upserted row in `query_stats`:

- **Dedupe key**: `(clusterId, host, timestamp, keyHash, queryShapeHash)`.
- **Timestamp source**: prefer `metrics.latestSeenTimestamp`, fall back to
  `asOf`, then to poll time.
- **Server-version gate**: `$queryStats` is available from MongoDB 7.1. The
  collector skips clusters where `topologies.queryStatsSupported === false`
  and logs a `skipped` audit row so the UI shows why a cluster is empty.

Because the dedupe key includes `timestamp`, a shape whose
`latestSeenTimestamp` advances each poll produces a **new** row each poll;
idle shapes upsert into the same row and don't grow the collection. The
collector also clones the `metrics` subdocument via EJSON so the BSON shape
stored matches what was used to read `latestSeenTimestamp`.

## Slow-query window (per-host watermark)

`collectSlowQueries` calls Atlas Performance Advisor
[`slowQueryLogs`](https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-listgroupprocessperformanceadvisorslowquerylogs/)
once per Atlas process per poll. The request window is sized **per host** so
each poll only re-fetches a small overlap with the previous one — keeping the
duplicate rate near the safety lag instead of asking Atlas for a fixed
lookback every poll.

For each `(clusterId, topologyHost)` the collector reads the latest stored
`slow_queries.timestamp` (the **watermark**) and computes:

```
floorMs    = nowMs - SLOW_QUERY_MAX_LOOKBACK_MS
sinceMs    = wmMs == null
             ? floorMs                                       // first run / no rows yet
             : Math.max(wmMs - SLOW_QUERY_SAFETY_LAG_MS, floorMs)
durationMs = nowMs - sinceMs
```

`SLOW_QUERY_SAFETY_LAG_MS` (default **60_000 ms**) is the small re-fetch
overlap that absorbs Atlas log delay, clock skew, and poll jitter.
`SLOW_QUERY_MAX_LOOKBACK_MS` (default **1_800_000 ms = 30 min**) is a hard cap
so a long outage or a fresh cluster can't trigger an unbounded fetch — older
rows in the gap are intentionally dropped because the API's `nLogs` cap
(5_000 lines per call in MongoAdvisor) makes pulling many hours of high-volume
traffic impractical.

The watermark `findOne` is backed by the `slow_queries_cluster_host_time`
index — see [Application database indexes](#application-database-indexes).

Per-poll behavior at the default 5 min cadence:

| Situation | `since` source | Window length |
| --- | --- | --- |
| First poll on a fresh cluster | `lookback-cap` | 30 min |
| Healthy steady state | `watermark` | ~6 min (5 min new + 1 min lag) |
| Crashed for ~10 min, then back | `watermark` | ~16 min |
| Crashed for ≥ 30 min, then back | `lookback-cap` | 30 min (older slice dropped) |

The `[slowQueries] … via=watermark|lookback-cap|first-run` log line shows
which branch fired each poll.

**Duplicates from the safety lag** are handled three ways. The bulk write uses
**`bulkWrite` of `updateOne` + `$setOnInsert` + `upsert: true`** with
**`ordered: false`**: the unique partial index `uniq_slow_log_dedupe` matches
an existing row by `(clusterId, host, id, timestamp, millis, ctx)`,
`$setOnInsert` skips the rewrite (slow-query rows are immutable events, so
there is nothing new to set on a match — only the index probe runs), and
`ordered: false` keeps the rest of the batch going if a rare race past dedupe
lands an `E11000`. The result is a steady-state duplicate cost of roughly
`SAFETY_LAG_MS / poll_interval` worth of index probes — at the defaults that
is around 20 % of the batch. Rows without a numeric `id` (parser fallback)
bypass the partial unique index and are appended via
`insertMany({ ordered: false })`, so duplicates are possible there only when
re-polling overlaps unsigned rows.

`$queryStats` (the in-memory aggregation source for `query_stats`) does not
have a comparable time-window parameter, so the watermark logic is
**slow-queries only**. `query_stats` already gets a new row on every distinct
`metrics.latestSeenTimestamp` and reuses the same compound key when activity
is unchanged, so `bulkWrite` upserts are sufficient there.

## `$indexStats` collector (unused / redundant)

Runs every 10 min. Lists user namespaces via the SRV client (so it hits the
primary — `listDatabases` on a secondary often fails), then runs
`$indexStats` on each namespace per host. An index whose
`accesses.ops === 0` is flagged **unused**; an index whose key is a strict
prefix of another's is flagged **redundant** (`isRedundantPrefix`).

`index_stats` is **snapshot-replaced** every poll: the prior rows for the
cluster are deleted and the new ones inserted. No retention work is needed
for this collection.

## Storage and fragmentation collector

Runs daily at 3 AM local (configurable via `STORAGE_HOUR` in
`src/collector.js`) plus a one-shot pass at startup so new clusters get
covered immediately. For each user namespace, it reads `collStats` and
computes:

- **Collection fragmentation %** from WiredTiger
  `block-manager.file bytes available for reuse` divided by `storageSize`.
- **Per-index fragmentation %** from `indexDetails[name].block-manager`.
- **Index-to-data ratio %** from `totalIndexSize / size`.

Like `index_stats`, this collection is snapshot-replaced — no retention work
needed.

## Disk usage and oplog window collectors

Both run every 5 min and **insert** a fresh row (no upsert / no replace).

- `disk_usage`: one document per poll per cluster from
  `db.admin.command({ dbStats: 1 })`, storing `fsTotalSizeBytes`,
  `fsUsedSizeBytes`, `usagePct`.
- `oplog_window`: one document per poll per cluster from the oldest and
  newest `ts` in `local.oplog.rs`, storing `windowHours`, `oldestTs`,
  `newestTs`.

Both are time-series collections from the retention layer's perspective and
are rolled up to `disk_usage_hourly` / `oplog_window_hourly` before TTL.

## Stored document timestamp (`query_stats` and `slow_queries`)

Time filters (`since`, time range in the UI) and sorts use the `timestamp`
field on each stored row. It does **not** always mean "the instant that user
query finished":

| Collection | What `timestamp` represents |
| --- | --- |
| `query_stats` | Prefer `metrics.latestSeenTimestamp`: UTC when the server last **observed activity** for this stats key (still aggregated — not a single query's "finished at" instant). If missing, use `asOf`: UTC when that partition row was read from the [$queryStats](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/) virtual collection (also not per-query event time). Then **poll time**. `metrics.lastExecutionMicros` is execution *duration*, not a calendar time — it is not used as `timestamp`. |
| `slow_queries` | Prefer the **log event time** parsed from the Performance Advisor line (MongoDB structured log field `t`). If that cannot be parsed, `timestamp` is the **collector run time** when the slow-query batch was ingested. |

Metrics routes filter with `since` against this same `timestamp` field. The
UI's relative time-range buttons (5 min / 1 h / 1 d / 1 week / **All**) are
converted to ISO instants before being sent as `since`; see
[dashboard.md](dashboard.md#filters) for the filter behavior and
[api.md](api.md#common-query-parameters) for the parameter contract.

## Slow query document fields (log-derived)

| Field | Source |
| --- | --- |
| `id` | Top-level `id` in the JSON slow-operation log line (integer), when present. |
| `ctx` | Top-level `ctx` (e.g. connection thread id). Stored as `""` when missing so the unique index remains stable. |
| `truncated` | `true` / `false` when the log exposes a `truncated` field (top-level or under `attr`); omitted when not present. |
| `command` / `originatingCommand` | Slow-op command body and (for `getmore`) the originating cursor command. Preserved so the UI can show the actual query and run `explain()`. |
| `raw` | The original log line, truncated to 20 KB. Used by the UI when `command` is missing. |
| `queryHash`, `planCacheKey` | Plan-cache identifiers extracted from `attr`. Used by the rollup to group identical shapes. |

## Application database indexes

Indexes are **not** created by the server's startup path for the legacy
collections — run them manually after deploy or when this doc changes.
Retention TTL + rollup indexes **are** created at server startup by
`src/retention.js` so they exist before the collector starts writing.

```bash
npm run indexes:ensure
# Or: node scripts/ensure-indexes.js
```

Uses `MONGO_URI` and `MONGO_DB` from `.env` (same as the app). The script is
[`scripts/ensure-indexes.js`](../scripts/ensure-indexes.js); it does **not**
run from [`src/db.js`](../src/db.js).

### Raw collections

| Collection | Index name | Keys | Unique | Purpose |
| --- | --- | --- | --- | --- |
| `query_stats` | `uniq_query_stats_observation` | `clusterId`, `host`, `timestamp`, `keyHash`, `queryShapeHash` | yes | One stored row per observation key including `timestamp`. The `bulkWrite` upserts use this full key set. When `latestSeenTimestamp` moves forward, a **new** row appears. `keyHash` may be null on older servers. |
| `query_stats` | `ttl_timestamp` | `timestamp` | no (TTL) | TTL after `RETENTION_RAW_DAYS + 1` day. See [retention.md](retention.md). |
| `slow_queries` | `uniq_slow_log_dedupe` | `clusterId`, `host`, `id`, `timestamp`, `millis`, `ctx` | yes (partial) | Same logical key as `{ id, timestamp, millis, ctx, host }` plus `clusterId`. Partial index — applies only when `id` is numeric. |
| `slow_queries` | `slow_queries_cluster_host_time` | `clusterId`, `host`, `timestamp` desc | no | Backs the per-host watermark `findOne` used by `collectSlowQueries`. |
| `slow_queries` | `ttl_timestamp` | `timestamp` | no (TTL) | TTL after `RETENTION_RAW_DAYS + 1` day. |
| `topologies` | `uniq_topology_per_cluster` | `clusterId` | yes | At most one topology document per cluster. |
| `monitor_logs` | `monitor_logs_timestamp` | `timestamp` desc | no | Recent audit rows for `/api/metrics/monitor-logs`. |
| `monitor_logs` | `ttl_timestamp` | `timestamp` | no (TTL) | TTL after `RETENTION_RAW_DAYS + 1` day. |
| `index_stats` | `index_stats_cluster_type_host_ns` | `clusterId`, `type`, `host`, `namespace` | no | Unused / redundant index listings. Snapshot-replaced per poll. |
| `storage_stats` | `storage_stats_cluster_ns` | `clusterId`, `namespace` | no | Storage scan rows. Snapshot-replaced per scan. |
| `disk_usage` | `disk_usage_cluster_time` | `clusterId`, `timestamp` desc | no | Latest disk samples per cluster. |
| `disk_usage` | `ttl_timestamp` | `timestamp` | no (TTL) | TTL after `RETENTION_RAW_DAYS + 1` day. |
| `oplog_window` | `oplog_window_cluster_time` | `clusterId`, `timestamp` desc | no | Latest oplog window samples. |
| `oplog_window` | `ttl_timestamp` | `timestamp` | no (TTL) | TTL after `RETENTION_RAW_DAYS + 1` day. |

### Rollup collections

Created by `src/retention.js#ensureRetentionIndexes` at server boot. See
[retention.md](retention.md) for the rollup schema.

| Collection | Index name | Keys | Unique |
| --- | --- | --- | --- |
| `query_stats_hourly` | `uniq_query_stats_hourly_bucket` | `clusterId`, `host`, `queryShapeHash`, `bucketStart` | yes |
| `query_stats_hourly` | `query_stats_hourly_cluster_ns_time` | `clusterId`, `namespace`, `bucketStart` desc | no |
| `slow_queries_hourly` | `uniq_slow_queries_hourly_bucket` | `clusterId`, `host`, `queryHash`, `planSummary`, `bucketStart` | yes |
| `slow_queries_hourly` | `slow_queries_hourly_app_comment` | `clusterId`, `appName`, `comment`, `bucketStart` desc | no |
| `disk_usage_hourly` | `uniq_disk_usage_hourly_bucket` | `clusterId`, `bucketStart` | yes |
| `oplog_window_hourly` | `uniq_oplog_window_hourly_bucket` | `clusterId`, `bucketStart` | yes |

All collections also have the default `_id` index.

If `createIndex` fails (usually duplicate keys in existing data), clean
duplicates or drop conflicting indexes, then run `npm run indexes:ensure`
again.

## Audit trail (`monitor_logs`)

Every collector pass writes a row via `logMonitorEvent` describing the
outcome (`ok`, `skipped`, `error`), the source collection, a short `detail`
message, and a small `meta` payload. The UI surfaces these rows on the
**Audit** tab; the API is `GET /api/metrics/monitor-logs?action=…&outcome=…`.
The retention rollup job emits its own
`action: "retention.rollup"` rows so the hourly aggregation activity is
visible in the same place.
