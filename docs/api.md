# HTTP API reference

All routes are exposed by [`src/server.js`](../src/server.js) and live under
the same Express app that serves the dashboard (`public/`). The stock server
does **not** add HTTP authentication — protect these routes at the network
or proxy layer.

- [Cluster registration](#cluster-registration)
- [Atlas database user provisioning](#atlas-database-user-provisioning)
- [Topology](#topology)
- [Metrics](#metrics)
- [Common query parameters](#common-query-parameters)
- [Application database indexes](#application-database-indexes)

## Cluster registration

| Method   | Endpoint                                 | Description                                                                                                  |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/health`                            | Ping application database.                                                                                   |
| `GET`    | `/api/clusters`                          | List clusters (secrets masked).                                                                              |
| `POST`   | `/api/clusters`                          | Register a cluster.                                                                                          |
| `GET`    | `/api/clusters/:id`                      | One cluster.                                                                                                 |
| `PATCH`  | `/api/clusters/:id`                      | Update cluster (`name`, `uri`, Atlas fields, `isPolling`; omit `uri` / `atlasPrivateKey` to leave unchanged). |
| `DELETE` | `/api/clusters/:id`                      | Remove cluster.                                                                                              |

## Atlas database user provisioning

See [Atlas database users — CLI and HTTP API](setup.md#atlas-database-users--cli-and-http-api)
for body fields and roles per preset.

| Method | Endpoint                                 | Description                                                                                                  |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/clusters/:id/atlas-database-users` | Create Atlas SCRAM user using stored cluster Atlas API keys.                                                 |
| `GET`  | `/api/atlas/database-users/presets`      | Preset ids for Atlas SCRAM user creation.                                                                    |
| `GET`  | `/api/atlas/database-users/defaults`     | Optional `{ projectId, publicKey }` from server env (for scripts / `curl`).                                  |
| `POST` | `/api/atlas/database-users`              | Create Atlas SCRAM user (credentials in JSON body).                                                          |

## Topology

| Method | Endpoint                              | Description                                                                                       |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/topologies`                     | All topologies.                                                                                   |
| `POST` | `/api/topologies/:id/discover`        | Refresh topology (also runs automatically after `PATCH /api/clusters/:id` when `uri` changes).    |

## Metrics

| Method | Endpoint                          | Description                                                                                        |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/metrics/databases`          | Distinct top-level databases for filters.                                                          |
| `GET`  | `/api/metrics/namespaces`         | Distinct namespaces (for backwards compatibility / scripting).                                     |
| `GET`  | `/api/metrics/hosts`              | Distinct hosts from topology.                                                                      |
| `GET`  | `/api/metrics/app-load`           | Aggregated load by appName.                                                                        |
| `GET`  | `/api/metrics/query-stats`        | Raw `$queryStats`-backed snapshots.                                                                |
| `GET`  | `/api/metrics/app-analysis`       | App-level analysis aggregates.                                                                     |
| `GET`  | `/api/metrics/impact-by-query`    | Per-query impact metrics.                                                                          |
| `GET`  | `/api/metrics/heatmap`            | Heatmap payload (IO/CPU grouping).                                                                 |
| `GET`  | `/api/metrics/bubble`             | Bubble chart payload.                                                                              |
| `GET`  | `/api/metrics/slow-queries`       | Slow query log documents.                                                                          |
| `GET`  | `/api/metrics/unused-indexes`     | Unused index rows.                                                                                 |
| `GET`  | `/api/metrics/redundant-indexes`  | Redundant index rows.                                                                              |
| `GET`  | `/api/metrics/storage`            | Storage / fragmentation rows.                                                                      |
| `GET`  | `/api/metrics/disk-usage`         | Latest disk usage per cluster.                                                                     |
| `GET`  | `/api/metrics/oplog-window`       | Latest oplog window per cluster.                                                                   |
| `GET`  | `/api/metrics/monitor-logs`       | Collector/API audit (`?limit=`, `?since=`, `?clusterId=`, `?action=`, `?outcome=`).                |

## Common query parameters

Most metrics routes accept the same filter set:

| Parameter   | Type                    | Description                                                                                                                                                          |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`     | ISO date                | Compared to each document's `timestamp`. See [Stored document timestamp](collector.md#stored-document-timestamp-query_stats-and-slow_queries) for what that means per collection. |
| `database`  | string (repeatable)     | Prefix-matches `namespace`. System DBs and the app DB are filtered out by [`src/hidden-dbs.js`](../src/hidden-dbs.js).                                              |
| `namespace` | string (repeatable)     | Exact match on `namespace`. Takes precedence when both `database` and `namespace` are sent.                                                                          |
| `host`      | string (repeatable)     | Replica-set member hostname (from `topologies.hosts`).                                                                                                               |
| `clusterId` | string (ObjectId)       | Restrict to one registered cluster.                                                                                                                                  |

Some routes also honor pagination parameters (`limit`, `offset`); see the
route handler in [`src/routes/metrics.js`](../src/routes/metrics.js) for
specifics.

When `since` is older than the raw-retention cutoff, metrics routes
transparently `$unionWith` the matching `*_hourly` rollup — see
[Retention — API behaviour across the boundary](retention.md#api-behaviour-across-the-boundary).

## Application database indexes

Retention TTL + rollup indexes are created automatically on server start.
The other indexes (compound uniques, dashboard read indexes) are **not** —
run them manually after deploy:

```bash
npm run indexes:ensure
# Or: node scripts/ensure-indexes.js
```

Full per-collection index reference (including TTL + rollup indexes) lives
in [Collector reference — Application database indexes](collector.md#application-database-indexes).
