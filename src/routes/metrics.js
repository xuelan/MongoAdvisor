const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { isHiddenTopLevelDb } = require("../hidden-dbs");
const { MONITOR_LOGS } = require("../monitor-log");
const { rawHotCutoff, COLLECTIONS: RC } = require("../retention");

const router = Router();

/** Driver appName for this service; keep in DB but hide from metrics APIs / UI. */
const SYSTEM_APP_NAME_REGEX = /^mongoadvisor$/i;

function matchExcludeSystemAppName(base = {}) {
  const exclude = { appName: { $not: SYSTEM_APP_NAME_REGEX } };
  if (!base || Object.keys(base).length === 0) return exclude;
  return { $and: [base, exclude] };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact `namespace` query wins; otherwise `database` matches db.collection-style namespaces. */
function applyNamespaceOrDatabaseFilter(filter, query) {
  if (query.namespace) {
    const ns = Array.isArray(query.namespace) ? query.namespace : [query.namespace];
    filter.namespace = ns.length === 1 ? ns[0] : { $in: ns };
    return;
  }
  if (query.database == null || query.database === "") return;
  const dbs = (Array.isArray(query.database) ? query.database : [query.database])
    .map((d) => String(d).trim())
    .filter(Boolean);
  if (dbs.length === 0) return;
  if (dbs.length === 1) {
    filter.namespace = new RegExp(`^${escapeRegex(dbs[0])}\\.`);
  } else {
    filter.namespace = { $in: dbs.map((db) => new RegExp(`^${escapeRegex(db)}\\.`)) };
  }
}

function buildFilter(query, { includeHost = true } = {}) {
  const filter = {};
  if (query.clusterId != null && query.clusterId !== "") {
    const sid = String(query.clusterId);
    if (!ObjectId.isValid(sid)) {
      const err = new Error("Invalid clusterId");
      err.statusCode = 400;
      throw err;
    }
    filter.clusterId = new ObjectId(sid);
  }
  if (query.since) filter.timestamp = { $gte: new Date(query.since) };
  applyNamespaceOrDatabaseFilter(filter, query);
  if (includeHost && query.host) {
    const hosts = Array.isArray(query.host) ? query.host : [query.host];
    filter.host = hosts.length === 1 ? hosts[0] : { $in: hosts };
  }
  return filter;
}

/**
 * Build a pipeline prefix that unions raw rows with hourly rollups when the
 * requested `since` predates the raw retention cutoff. Fast path (no $unionWith)
 * when the time range fits entirely in the raw hot window.
 *
 * The rollup branch projects bucketStart → timestamp and aliases pre-aggregated
 * fields back to the raw column names so downstream $group/$sum/$avg stages work
 * unchanged. Pre-summed fields (execCount, totalExecMicros, …) compose correctly:
 * Σ(hourly deltas) across the range == Σ(raw deltas) over the same range.
 *
 * Three cases:
 *   1. `since` is in the raw hot window (`since >= cutoff`) → raw only.
 *   2. `since` predates the cutoff → raw `[cutoff, now]` ∪ rollup `[since, cutoff)`.
 *   3. `since` is undefined (the "All" UI filter) → raw `[cutoff, now]` ∪ rollup `(-∞, cutoff)`
 *      so the long-term hourly history is included instead of silently capped at RAW_TTL_DAYS.
 */
function buildQueryStatsPipelinePrefix(matchFilter) {
  const since = matchFilter.timestamp?.$gte;
  const cutoff = rawHotCutoff();
  if (since && since >= cutoff) {
    return [{ $match: matchFilter }];
  }

  // Raw covers [cutoff, now]; rollup covers [since ?? -∞, cutoff)
  const rawMatch = { ...matchFilter, timestamp: { $gte: cutoff } };
  const rollupMatch = { ...matchFilter };
  delete rollupMatch.timestamp;
  rollupMatch.bucketStart = since ? { $gte: since, $lt: cutoff } : { $lt: cutoff };

  return [
    { $match: rawMatch },
    {
      $unionWith: {
        coll: RC.QUERY_STATS_HOURLY,
        pipeline: [
          { $match: rollupMatch },
          {
            $project: {
              timestamp: "$bucketStart",
              clusterId: 1,
              clusterName: 1,
              host: 1,
              appName: 1,
              namespace: 1,
              queryShapeHash: 1,
              comment: 1,
              execCount: 1,
              totalExecMicros: 1,
              docsExamined: 1,
              keysExamined: 1,
              firstResponseExecMicros: 1,
              queryShape: "$queryShapeSample",
              lastExecutionMicros: "$lastExecutionMicrosMax",
            },
          },
        ],
      },
    },
  ];
}

/**
 * Same idea for slow_queries. Each row coming out of the union carries a
 * `_weight` field (1 for raw, $count for rollup) plus `_total*` pre-aggregated
 * fields. Downstream pipelines should use:
 *   { $sum: "$_weight" }                  instead of { $sum: 1 }
 *   { $sum: { $ifNull:["$_totalMillis", "$millis"]} }   for cross-tier sums
 *   { $max: { $ifNull:["$_maxMillis", "$millis"]} }     for cross-tier max
 * Averages must be recomputed after $group as totalMillis / count to stay
 * correct across mixed weights. See /heatmap and /bubble for the pattern.
 */
function buildSlowQueriesPipelinePrefix(matchFilter) {
  const since = matchFilter.timestamp?.$gte;
  const cutoff = rawHotCutoff();

  const tagRawWeight = {
    $addFields: {
      _weight: 1,
      _totalMillis: "$millis",
      _maxMillis: "$millis",
      _totalCpuNanos: { $ifNull: ["$cpuNanos", 0] },
      _totalBytesRead: { $ifNull: ["$bytesRead", 0] },
      _totalDocsExamined: { $ifNull: ["$docsExamined", 0] },
      _totalKeysExamined: { $ifNull: ["$keysExamined", 0] },
    },
  };

  if (since && since >= cutoff) {
    return [{ $match: matchFilter }, tagRawWeight];
  }

  const rawMatch = { ...matchFilter, timestamp: { $gte: cutoff } };
  const rollupMatch = { ...matchFilter };
  delete rollupMatch.timestamp;
  rollupMatch.bucketStart = since ? { $gte: since, $lt: cutoff } : { $lt: cutoff };

  return [
    { $match: rawMatch },
    tagRawWeight,
    {
      $unionWith: {
        coll: RC.SLOW_QUERIES_HOURLY,
        pipeline: [
          { $match: rollupMatch },
          {
            $project: {
              timestamp: "$bucketStart",
              clusterId: 1,
              clusterName: 1,
              host: 1,
              appName: 1,
              namespace: 1,
              comment: 1,
              queryHash: 1,
              planSummary: 1,
              _weight: "$count",
              _totalMillis: "$totalMillis",
              _maxMillis: "$maxMillis",
              _totalCpuNanos: "$totalCpuNanos",
              _totalBytesRead: "$totalBytesRead",
              _totalDocsExamined: "$totalDocsExamined",
              _totalKeysExamined: "$totalKeysExamined",
              millis: "$avgMillis",  // single representative for any downstream code that still uses $millis
            },
          },
        ],
      },
    },
  ];
}

// GET /api/metrics/namespaces -- distinct namespaces for filter dropdown (?clusterId=)
router.get("/namespaces", async (req, res, next) => {
  try {
    const match = {};
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      match.clusterId = new ObjectId(sid);
    }
    const namespaces = await getDb()
      .collection("query_stats")
      .distinct("namespace", Object.keys(match).length ? match : undefined);
    res.json(
      namespaces
        .filter(Boolean)
        .filter((ns) => !isHiddenTopLevelDb(ns.split(".")[0]))
        .sort(),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/databases -- database names from each cluster's topology document
// (populated by discovery via `listDatabases`). This is the authoritative list and works
// for newly-registered clusters that have no query_stats / slow_queries data yet.
// Clusters with `catalogTooLarge: true` skip listDatabases and contribute nothing here.
router.get("/databases", async (req, res, next) => {
  try {
    const match = {};
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      match.clusterId = new ObjectId(sid);
    }
    const topos = await getDb()
      .collection("topologies")
      .find(match, { projection: { databases: 1 } })
      .toArray();
    const dbs = new Set();
    for (const t of topos) {
      for (const d of t.databases || []) {
        if (d && !isHiddenTopLevelDb(d)) dbs.add(d);
      }
    }
    res.json([...dbs].sort());
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/hosts -- hosts from topologies (?clusterId= for one cluster)
router.get("/hosts", async (req, res, next) => {
  try {
    const q = {};
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      q.clusterId = new ObjectId(sid);
    }
    const topos = await getDb().collection("topologies").find(q).toArray();
    const hosts = new Set();
    for (const t of topos) {
      for (const h of t.hosts || []) hosts.add(h);
    }
    res.json([...hosts].sort());
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/query-stats?clusterId=X&since=ISO&namespace=db.coll
router.get("/query-stats", async (req, res, next) => {
  try {
    const filter = matchExcludeSystemAppName(buildFilter(req.query));
    const prefix = buildQueryStatsPipelinePrefix(filter);

    const docs = await getDb()
      .collection("query_stats")
      .aggregate([...prefix, { $sort: { timestamp: -1 } }, { $limit: 1000 }])
      .toArray();

    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/slow-queries?clusterId=X&since=ISO&namespace=db.coll
//
// Returns raw slow-query events (with command bodies) when the time range is
// inside the raw retention window. Older ranges return rollup exemplars
// projected to look like raw rows so the UI can keep rendering — note these
// won't have id/raw/originatingCommand for events older than RETENTION_RAW_DAYS.
router.get("/slow-queries", async (req, res, next) => {
  try {
    const filter = matchExcludeSystemAppName(buildFilter(req.query));
    const since = filter.timestamp?.$gte;
    const cutoff = rawHotCutoff();

    if (since && since >= cutoff) {
      const docs = await getDb()
        .collection("slow_queries")
        .find(filter).sort({ timestamp: -1 }).limit(500).toArray();
      return res.json(docs);
    }

    // Hybrid: take recent raw + older rollup exemplars projected to raw-ish shape.
    // When `since` is undefined (the "All" filter), the rollup branch covers all
    // history before `cutoff`, so old TTL-purged events still appear via the exemplar.
    const rawMatch = { ...filter, timestamp: { $gte: cutoff } };
    const rollupMatch = { ...filter };
    delete rollupMatch.timestamp;
    rollupMatch.bucketStart = since ? { $gte: since, $lt: cutoff } : { $lt: cutoff };

    const docs = await getDb().collection("slow_queries").aggregate([
      { $match: rawMatch },
      {
        $unionWith: {
          coll: RC.SLOW_QUERIES_HOURLY,
          pipeline: [
            { $match: rollupMatch },
            {
              $project: {
                timestamp: "$exemplar.timestamp",
                clusterId: 1, clusterName: 1, host: 1,
                appName: 1, namespace: 1, comment: 1,
                queryHash: 1, planSummary: 1,
                millis: "$exemplar.millis",
                command: "$exemplar.command",
                originatingCommand: "$exemplar.originatingCommand",
                raw: "$exemplar.raw",
                _fromRollup: { $literal: true },
              },
            },
          ],
        },
      },
      { $sort: { timestamp: -1 } },
      { $limit: 500 },
    ]).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/app-load?clusterId=X&namespace=db.coll&since=ISO
router.get("/app-load", async (req, res, next) => {
  try {
    const matchStage = matchExcludeSystemAppName(buildFilter(req.query));

    const pipeline = [
      ...buildQueryStatsPipelinePrefix(matchStage),
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: { clusterId: "$clusterId", clusterName: "$clusterName", appName: "$appName" },
          latestTimestamp: { $first: "$timestamp" },
          totalExecCount: { $sum: "$execCount" },
          totalExecMicros: { $sum: "$totalExecMicros" },
          totalDocsExamined: { $sum: "$docsExamined" },
          totalKeysExamined: { $sum: "$keysExamined" },
          queryShapes: { $addToSet: "$queryShapeHash" },
        },
      },
      {
        $project: {
          _id: 0,
          clusterId: "$_id.clusterId",
          clusterName: "$_id.clusterName",
          appName: "$_id.appName",
          latestTimestamp: 1,
          totalExecCount: 1,
          totalExecMicros: 1,
          totalDocsExamined: 1,
          totalKeysExamined: 1,
          distinctShapes: { $size: "$queryShapes" },
        },
      },
      { $sort: { totalExecCount: -1 } },
    ];

    const docs = await getDb().collection("query_stats").aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/app-analysis?clusterId=X&namespace=db.coll&since=ISO
router.get("/app-analysis", async (req, res, next) => {
  try {
    const matchStage = matchExcludeSystemAppName(buildFilter(req.query));

    const pipeline = [
      ...buildQueryStatsPipelinePrefix(matchStage),
      {
        $group: {
          _id: {
            appName: "$appName",
            clusterName: "$clusterName",
            queryShapeHash: "$queryShapeHash",
          },
          queryShape: { $first: "$queryShape" },
          namespace: { $first: "$namespace" },
          totalExecCount: { $sum: "$execCount" },
          totalExecMicros: { $sum: "$totalExecMicros" },
          totalDocsExamined: { $sum: "$docsExamined" },
          totalKeysExamined: { $sum: "$keysExamined" },
          maxExecMicros: { $max: "$firstResponseExecMicros.max" },
          snapshots: { $sum: 1 },
        },
      },
      {
        $addFields: {
          avgMicrosPerExec: {
            $cond: [
              { $gt: ["$totalExecCount", 0] },
              { $round: [{ $divide: ["$totalExecMicros", "$totalExecCount"] }, 0] },
              0,
            ],
          },
          avgDocsPerExec: {
            $cond: [
              { $gt: ["$totalExecCount", 0] },
              { $round: [{ $divide: ["$totalDocsExamined", "$totalExecCount"] }, 1] },
              0,
            ],
          },
          scanEfficiency: {
            $cond: [
              { $gt: ["$totalDocsExamined", 0] },
              { $round: [{ $multiply: [{ $divide: ["$totalKeysExamined", "$totalDocsExamined"] }, 100] }, 1] },
              null,
            ],
          },
          classification: {
            $switch: {
              branches: [
                {
                  case: {
                    $and: [
                      { $gt: ["$totalDocsExamined", 1000] },
                      { $eq: ["$totalKeysExamined", 0] },
                    ],
                  },
                  then: "COLLSCAN (IO-bound)",
                },
                {
                  case: {
                    $and: [
                      { $gt: ["$totalDocsExamined", 0] },
                      { $gt: ["$totalKeysExamined", 0] },
                      { $gt: [{ $divide: ["$totalDocsExamined", { $max: ["$totalKeysExamined", 1] }] }, 10] },
                    ],
                  },
                  then: "Inefficient scan (IO-bound)",
                },
                {
                  case: {
                    $and: [
                      { $gt: ["$totalExecMicros", 0] },
                      { $gt: ["$totalExecCount", 0] },
                      { $gt: [{ $divide: ["$totalExecMicros", "$totalExecCount"] }, 100000] },
                      { $lte: ["$totalDocsExamined", 100] },
                    ],
                  },
                  then: "CPU-bound (compute heavy)",
                },
                {
                  case: {
                    $and: [
                      { $gt: ["$totalKeysExamined", 0] },
                      { $lte: [{ $divide: ["$totalDocsExamined", { $max: ["$totalKeysExamined", 1] }] }, 1.5] },
                    ],
                  },
                  then: "Index-covered (efficient)",
                },
              ],
              default: "Mixed",
            },
          },
        },
      },
      {
        $group: {
          _id: { appName: "$_id.appName", clusterName: "$_id.clusterName" },
          totalExecCount: { $sum: "$totalExecCount" },
          totalExecMicros: { $sum: "$totalExecMicros" },
          totalDocsExamined: { $sum: "$totalDocsExamined" },
          totalKeysExamined: { $sum: "$totalKeysExamined" },
          distinctShapes: { $sum: 1 },
          collscanShapes: {
            $sum: { $cond: [{ $regexMatch: { input: "$classification", regex: /COLLSCAN/ } }, 1, 0] },
          },
          ioBoundShapes: {
            $sum: { $cond: [{ $regexMatch: { input: "$classification", regex: /IO-bound/ } }, 1, 0] },
          },
          cpuBoundShapes: {
            $sum: { $cond: [{ $regexMatch: { input: "$classification", regex: /CPU-bound/ } }, 1, 0] },
          },
          efficientShapes: {
            $sum: { $cond: [{ $regexMatch: { input: "$classification", regex: /efficient/ } }, 1, 0] },
          },
          topQueries: {
            $topN: {
              n: 5,
              sortBy: { totalExecMicros: -1 },
              output: {
                queryShapeHash: "$_id.queryShapeHash",
                namespace: "$namespace",
                command: "$queryShape.command",
                totalExecCount: "$totalExecCount",
                totalExecMicros: "$totalExecMicros",
                totalDocsExamined: "$totalDocsExamined",
                totalKeysExamined: "$totalKeysExamined",
                avgMicrosPerExec: "$avgMicrosPerExec",
                classification: "$classification",
              },
            },
          },
        },
      },
      {
        $addFields: {
          avgMicrosPerExec: {
            $cond: [
              { $gt: ["$totalExecCount", 0] },
              { $round: [{ $divide: ["$totalExecMicros", "$totalExecCount"] }, 0] },
              0,
            ],
          },
          overallClassification: {
            $cond: [
              { $gt: ["$ioBoundShapes", "$cpuBoundShapes"] },
              "IO-bound",
              { $cond: [{ $gt: ["$cpuBoundShapes", 0] }, "CPU-bound", "Balanced"] },
            ],
          },
        },
      },
      {
        $project: {
          _id: 0,
          appName: "$_id.appName",
          clusterName: "$_id.clusterName",
          totalExecCount: 1,
          totalExecMicros: 1,
          totalDocsExamined: 1,
          totalKeysExamined: 1,
          avgMicrosPerExec: 1,
          distinctShapes: 1,
          collscanShapes: 1,
          ioBoundShapes: 1,
          cpuBoundShapes: 1,
          efficientShapes: 1,
          overallClassification: 1,
          topQueries: 1,
        },
      },
      { $sort: { totalExecMicros: -1 } },
    ];

    const docs = await getDb().collection("query_stats").aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/impact-by-query?clusterId=X&namespace=db.coll&since=ISO
router.get("/impact-by-query", async (req, res, next) => {
  try {
    const matchStage = matchExcludeSystemAppName(buildFilter(req.query));

    const pipeline = [
      ...buildQueryStatsPipelinePrefix(matchStage),
      {
        $group: {
          _id: { appName: "$appName", queryShapeHash: "$queryShapeHash" },
          namespace: { $first: "$namespace" },
          command: { $first: "$queryShape.command" },
          comment: { $first: "$comment" },
          totalExecCount: { $sum: "$execCount" },
          totalExecMicros: { $sum: "$totalExecMicros" },
          totalDocsExamined: { $sum: "$docsExamined" },
          totalKeysExamined: { $sum: "$keysExamined" },
        },
      },
      {
        $project: {
          _id: 0,
          appName: "$_id.appName",
          queryShapeHash: "$_id.queryShapeHash",
          namespace: 1,
          command: 1,
          comment: 1,
          totalExecCount: 1,
          totalExecMicros: 1,
          totalDocsExamined: 1,
          totalKeysExamined: 1,
        },
      },
      { $sort: { totalExecMicros: -1 } },
    ];

    const docs = await getDb().collection("query_stats").aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/heatmap?clusterId=X&namespace=db.coll&since=ISO
// Sourced from slow_queries (Atlas Logs API): cpuNanos for CPU, bytesRead for IO.
// When `since` predates RETENTION_RAW_DAYS, the older slice is served from the
// hourly rollup via buildSlowQueriesPipelinePrefix (_weight = pre-summed count).
router.get("/heatmap", async (req, res, next) => {
  try {
    const matchStage = matchExcludeSystemAppName(buildFilter(req.query));

    const pipeline = [
      ...buildSlowQueriesPipelinePrefix(matchStage),
      {
        $group: {
          _id: { appName: "$appName", comment: "$comment" },
          namespaces: { $addToSet: "$namespace" },
          count: { $sum: "$_weight" },
          totalCpuNanos: { $sum: "$_totalCpuNanos" },
          totalBytesRead: { $sum: "$_totalBytesRead" },
          totalMillis: { $sum: "$_totalMillis" },
          maxMillis: { $max: "$_maxMillis" },
          totalDocsExamined: { $sum: "$_totalDocsExamined" },
          totalKeysExamined: { $sum: "$_totalKeysExamined" },
          planSummaries: { $addToSet: "$planSummary" },
        },
      },
      {
        $addFields: {
          avgCpuNanos: { $cond: [{ $gt: ["$count", 0] }, { $divide: ["$totalCpuNanos", "$count"] }, 0] },
          avgBytesRead: { $cond: [{ $gt: ["$count", 0] }, { $divide: ["$totalBytesRead", "$count"] }, 0] },
          avgMillis: { $cond: [{ $gt: ["$count", 0] }, { $divide: ["$totalMillis", "$count"] }, 0] },
        },
      },
      {
        $project: {
          _id: 0,
          appName: "$_id.appName",
          comment: "$_id.comment",
          namespaces: 1,
          count: 1,
          totalCpuNanos: 1,
          totalCpuMs: { $round: [{ $divide: ["$totalCpuNanos", 1e6] }, 1] },
          avgCpuMs: { $round: [{ $divide: ["$avgCpuNanos", 1e6] }, 1] },
          totalBytesRead: 1,
          totalBytesReadMB: { $round: [{ $divide: ["$totalBytesRead", 1048576] }, 2] },
          avgBytesReadMB: { $round: [{ $divide: ["$avgBytesRead", 1048576] }, 2] },
          totalMillis: 1,
          avgMillis: { $round: ["$avgMillis", 0] },
          maxMillis: 1,
          totalDocsExamined: 1,
          totalKeysExamined: 1,
          planSummaries: 1,
        },
      },
      { $sort: { totalMillis: -1 } },
    ];

    const docs = await getDb().collection("slow_queries").aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/bubble — top 20 appName+comment from slow_queries for bubble chart
router.get("/bubble", async (req, res, next) => {
  try {
    const matchStage = matchExcludeSystemAppName(buildFilter(req.query));

    const pipeline = [
      ...buildSlowQueriesPipelinePrefix(matchStage),
      {
        $group: {
          _id: { appName: "$appName", comment: "$comment" },
          count: { $sum: "$_weight" },
          totalMillis: { $sum: "$_totalMillis" },
          maxMillis: { $max: "$_maxMillis" },
          totalCpuNanos: { $sum: "$_totalCpuNanos" },
          totalBytesRead: { $sum: "$_totalBytesRead" },
          totalDocsExamined: { $sum: "$_totalDocsExamined" },
          totalKeysExamined: { $sum: "$_totalKeysExamined" },
          namespaces: { $addToSet: "$namespace" },
          planSummaries: { $addToSet: "$planSummary" },
        },
      },
      {
        $addFields: {
          avgMillis: { $cond: [{ $gt: ["$count", 0] }, { $divide: ["$totalMillis", "$count"] }, 0] },
        },
      },
      {
        $project: {
          _id: 0,
          appName: "$_id.appName",
          comment: "$_id.comment",
          count: 1,
          totalMillis: 1,
          avgMillis: { $round: ["$avgMillis", 0] },
          maxMillis: 1,
          totalCpuMs: { $round: [{ $divide: ["$totalCpuNanos", 1e6] }, 1] },
          totalBytesReadMB: { $round: [{ $divide: ["$totalBytesRead", 1048576] }, 2] },
          totalDocsExamined: 1,
          totalKeysExamined: 1,
          namespaces: 1,
          planSummaries: 1,
        },
      },
      { $sort: { totalMillis: -1 } },
      { $limit: 20 },
    ];

    const docs = await getDb().collection("slow_queries").aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/slow-query-sample?appName=X&comment=Y&since=ISO&namespace=&host=&clusterId=
// Returns the most recent matching slow_query doc — used by the "Explain" popup to show the
// actual query body before running explain("executionStats") against a chosen cluster.
//
// When no raw row exists (e.g. the matching events have been TTL-purged after
// RETENTION_RAW_DAYS), falls back to the exemplar stored in `slow_queries_hourly`.
router.get("/slow-query-sample", async (req, res, next) => {
  try {
    const base = buildFilter(req.query);
    const filter = matchExcludeSystemAppName(base);

    const inner = {};
    if (req.query.appName !== undefined) {
      // Empty string is a valid appName in the chart ("(no appName)") — match missing/null.
      inner.appName = req.query.appName === "" ? { $in: [null, ""] } : req.query.appName;
    }
    if (req.query.comment !== undefined) {
      inner.comment = req.query.comment === "" ? { $in: [null, ""] } : req.query.comment;
    }

    const combined = Object.keys(inner).length
      ? (filter.$and ? { $and: [...filter.$and, inner] } : { $and: [filter, inner] })
      : filter;

    const doc = await getDb()
      .collection("slow_queries")
      .find(combined)
      .sort({ millis: -1, timestamp: -1 })
      .limit(1)
      .next();

    if (doc) return res.json(doc);

    // Fallback: rebuild filter against slow_queries_hourly (timestamp → bucketStart)
    const rollupFilter = JSON.parse(JSON.stringify(combined, (_, v) =>
      v instanceof Date ? { __date: v.toISOString() } : v,
    ));
    function revive(obj) {
      if (!obj || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(revive);
      if (obj.__date) return new Date(obj.__date);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "timestamp") {
          out.bucketStart = revive(v);
        } else {
          out[k] = revive(v);
        }
      }
      return out;
    }
    const rolledFilter = revive(rollupFilter);

    const rolled = await getDb()
      .collection(RC.SLOW_QUERIES_HOURLY)
      .find(rolledFilter)
      .sort({ maxMillis: -1, bucketStart: -1 })
      .limit(1)
      .next();

    if (!rolled) return res.status(404).json({ error: "No matching slow query found" });
    res.json({
      _fromRollup: true,
      clusterId: rolled.clusterId,
      clusterName: rolled.clusterName,
      host: rolled.host,
      appName: rolled.appName,
      namespace: rolled.namespace,
      comment: rolled.comment,
      queryHash: rolled.queryHash,
      planSummary: rolled.planSummary,
      timestamp: rolled.exemplar?.timestamp || rolled.bucketStart,
      millis: rolled.exemplar?.millis ?? rolled.maxMillis,
      command: rolled.exemplar?.command || null,
      originatingCommand: rolled.exemplar?.originatingCommand || null,
      raw: rolled.exemplar?.raw || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/unused-indexes (?clusterId=&host=)
router.get("/unused-indexes", async (req, res, next) => {
  try {
    const filter = { type: "unused" };
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      filter.clusterId = new ObjectId(sid);
    }
    if (req.query.host) {
      const hosts = Array.isArray(req.query.host) ? req.query.host : [req.query.host];
      filter.host = hosts.length === 1 ? hosts[0] : { $in: hosts };
    }
    applyNamespaceOrDatabaseFilter(filter, req.query);
    const docs = await getDb()
      .collection("index_stats")
      .find(filter)
      .sort({ namespace: 1, indexName: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/redundant-indexes (?clusterId=&host=)
router.get("/redundant-indexes", async (req, res, next) => {
  try {
    const filter = { type: "redundant" };
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      filter.clusterId = new ObjectId(sid);
    }
    if (req.query.host) {
      const hosts = Array.isArray(req.query.host) ? req.query.host : [req.query.host];
      filter.host = hosts.length === 1 ? hosts[0] : { $in: hosts };
    }
    applyNamespaceOrDatabaseFilter(filter, req.query);
    const docs = await getDb()
      .collection("index_stats")
      .find(filter)
      .sort({ namespace: 1, indexName: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/monitor-logs — MongoAdvisor collector / API audit trail
router.get("/monitor-logs", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10) || 200, 1), 1000);
    const filter = {};
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      filter.clusterId = new ObjectId(sid);
    }
    if (req.query.since) filter.timestamp = { $gte: new Date(req.query.since) };
    if (req.query.action) filter.action = String(req.query.action);
    if (req.query.outcome) filter.outcome = String(req.query.outcome);
    const docs = await getDb()
      .collection(MONITOR_LOGS)
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/storage — collection-level storage and fragmentation (?clusterId=&namespace=&database=)
router.get("/storage", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      filter.clusterId = new ObjectId(sid);
    }
    applyNamespaceOrDatabaseFilter(filter, req.query);
    const docs = await getDb()
      .collection("storage_stats")
      .find(filter)
      .sort({ storageSizeBytes: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/disk-usage — latest disk usage per cluster (?clusterId= for one cluster)
router.get("/disk-usage", async (req, res, next) => {
  try {
    const initialMatch = { clusterId: { $exists: true, $ne: null } };
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      initialMatch.clusterId = new ObjectId(sid);
    }
    const docs = await getDb()
      .collection("disk_usage")
      .aggregate([
        { $match: initialMatch },
        { $sort: { timestamp: -1 } },
        // Normalize id so ObjectId vs string (e.g. after restore) does not split one cluster into two rows
        { $addFields: { _cid: { $toString: "$clusterId" } } },
        { $group: {
          _id: "$_cid",
          clusterName: { $first: "$clusterName" },
          timestamp: { $first: "$timestamp" },
          fsTotalSizeBytes: { $first: "$fsTotalSizeBytes" },
          fsUsedSizeBytes: { $first: "$fsUsedSizeBytes" },
          fsFreeBytes: { $first: "$fsFreeBytes" },
          usagePct: { $first: "$usagePct" },
        }},
        { $sort: { clusterName: 1 } },
        { $project: {
          _id: 0,
          clusterId: "$_id",
          clusterName: 1,
          timestamp: 1,
          fsTotalSizeBytes: 1,
          fsUsedSizeBytes: 1,
          fsFreeBytes: 1,
          usagePct: 1,
        }},
      ])
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/oplog-window — latest oplog window per cluster (?clusterId= for one cluster)
router.get("/oplog-window", async (req, res, next) => {
  try {
    const initialMatch = { clusterId: { $exists: true, $ne: null } };
    if (req.query.clusterId != null && req.query.clusterId !== "") {
      const sid = String(req.query.clusterId);
      if (!ObjectId.isValid(sid)) return res.status(400).json({ error: "Invalid clusterId" });
      initialMatch.clusterId = new ObjectId(sid);
    }
    const docs = await getDb()
      .collection("oplog_window")
      .aggregate([
        { $match: initialMatch },
        { $sort: { timestamp: -1 } },
        { $addFields: { _cid: { $toString: "$clusterId" } } },
        { $group: {
          _id: "$_cid",
          clusterName: { $first: "$clusterName" },
          timestamp: { $first: "$timestamp" },
          windowHours: { $first: "$windowHours" },
          oldestTs: { $first: "$oldestTs" },
          newestTs: { $first: "$newestTs" },
        }},
        { $sort: { clusterName: 1 } },
        { $project: {
          _id: 0,
          clusterId: "$_id",
          clusterName: 1,
          timestamp: 1,
          windowHours: 1,
          oldestTs: 1,
          newestTs: 1,
        }},
      ])
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildQueryStatsPipelinePrefix = buildQueryStatsPipelinePrefix;
module.exports.buildSlowQueriesPipelinePrefix = buildSlowQueriesPipelinePrefix;
