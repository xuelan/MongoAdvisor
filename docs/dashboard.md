# Dashboard reference (live monitoring)

This page documents the **live monitoring** mode: the main dashboard at
`http://localhost:3000` (`public/index.html`). After you register cluster
URIs, embedded pollers continuously ingest metrics into the MongoAdvisor app
DB; the UI reads that time-series data via the REST API.

For **offline auditing** — upload `getMongoData.js` snapshots and generate
shareable HTML without network access to the cluster — see
[Cluster Reports (offline analysis)](reports.md).

The frontend in [`public/`](../public) uses
[Chart.js](https://www.chartjs.org/) and talks to the same Express process
as the API ([`src/server.js`](../src/server.js)). Default port `3000` —
override with `PORT`.

- [Charts and panels](#charts-and-panels)
- [Filters](#filters)
- [Empty states](#empty-states)

## Charts and panels

| Panel                                        | Source                              | Notes                                                                                                                          |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Monitored clusters**                       | `clusters` + `topologies`           | Register URIs and optional Atlas API fields; **Edit connection** to update an existing cluster; topology refresh.              |
| **Disk usage** / **Oplog window**            | `disk_usage`, `oplog_window`        | Per-cluster gauges (latest sample).                                                                                            |
| **Execution count / total time / slowest**   | `query_stats` (top 20 by appName)   | Requires MongoDB **7.1+** for [`$queryStats`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/). |
| **Slow-query impact bubble**                 | `slow_queries`                      | appName + comment grouping, top 20.                                                                                            |
| **IO / CPU heatmaps**                        | `slow_queries`                      | Treemaps from [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/) slow-query logs, top 20.    |
| **Unused / redundant indexes**               | `index_stats`                       | From `$indexStats` and prefix rules.                                                                                           |
| **Storage & fragmentation**                  | `storage_stats`                     | Sortable table (daily data).                                                                                                   |
| **Audit log**                                | `monitor_logs`                      | Collector + API events; see [Collector reference — Audit trail](collector.md#audit-trail-monitor_logs).                       |

## Filters

Charts that use query stats or slow queries honor:

| Filter         | Description                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time range** | 5 min, 1 hour, 1 day, 1 week, or **All**. The **All** button triggers the union-with-rollup pipeline; see [Retention — API behaviour](retention.md#api-behaviour-across-the-boundary). |
| **Nodes**      | One checkbox per replica set member (from topology); reset to "all checked" when the dashboard cluster select changes.                                                       |
| **Databases**  | Distinct top-level databases from `query_stats`; system DBs and the app DB `mongoadvisor` are hidden from the picker (see [`src/hidden-dbs.js`](../src/hidden-dbs.js)); reset to "all checked" on switch. |

## Empty states

The dashboard surfaces actionable badges instead of silently empty charts:

- **⚠ auth failed** — `hello` failed (wrong credentials) but SRV resolution
  succeeded. The topology is saved with `helloOk: false`. Fix the URI on
  the cluster row.
- **⚠ N collections — heavy scans skipped** — `catalogStats.collections >
  10_000`. Per-namespace pollers (`storage_stats`, `index_stats`) are
  paused for that cluster. Links to the
  [Reduce the Number of Collections](https://www.mongodb.com/docs/manual/data-modeling/design-antipatterns/reduce-collections/#reduce-the-number-of-collections)
  anti-pattern doc.
- **$queryStats unsupported** — MongoDB < 7.1. Other collectors continue;
  this single poll is skipped with an audit row. See
  [Collector reference — `$queryStats` collector](collector.md#querystats-collector).
- **Explain rollup notice** — when the Explain popup falls back to a
  `slow_queries_hourly.exemplar` document (raw row TTL'd), the result is
  marked `_fromRollup: true` and the UI warns the user.
