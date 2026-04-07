const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

const router = Router();

function buildFilter(query, { includeHost = true } = {}) {
  const filter = {};
  if (query.clusterId) filter.clusterId = new ObjectId(query.clusterId);
  if (query.since) filter.timestamp = { $gte: new Date(query.since) };
  if (query.namespace) {
    const ns = Array.isArray(query.namespace) ? query.namespace : [query.namespace];
    filter.namespace = ns.length === 1 ? ns[0] : { $in: ns };
  }
  if (includeHost && query.host) {
    const hosts = Array.isArray(query.host) ? query.host : [query.host];
    filter.host = hosts.length === 1 ? hosts[0] : { $in: hosts };
  }
  return filter;
}

// GET /api/metrics/namespaces -- distinct namespaces for filter dropdown
router.get("/namespaces", async (_req, res, next) => {
  try {
    const namespaces = await getDb()
      .collection("query_stats")
      .distinct("namespace");
    res.json(namespaces.filter(Boolean).sort());
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/hosts -- all hosts from topologies
router.get("/hosts", async (_req, res, next) => {
  try {
    const topos = await getDb().collection("topologies").find().toArray();
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
    const filter = buildFilter(req.query);

    const docs = await getDb()
      .collection("query_stats")
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(1000)
      .toArray();

    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/slow-queries?clusterId=X&since=ISO&namespace=db.coll
router.get("/slow-queries", async (req, res, next) => {
  try {
    const filter = buildFilter(req.query);

    const docs = await getDb()
      .collection("slow_queries")
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(500)
      .toArray();

    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/app-load?clusterId=X&namespace=db.coll&since=ISO
router.get("/app-load", async (req, res, next) => {
  try {
    const matchStage = buildFilter(req.query);

    const pipeline = [
      { $match: matchStage },
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
    const matchStage = buildFilter(req.query);

    const pipeline = [
      { $match: matchStage },
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
    const matchStage = buildFilter(req.query);

    const pipeline = [
      { $match: matchStage },
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
// Sourced from slow_queries (Atlas Logs API): cpuNanos for CPU, bytesRead for IO
router.get("/heatmap", async (req, res, next) => {
  try {
    const matchStage = buildFilter(req.query);

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: { appName: "$appName", comment: "$comment" },
          namespaces: { $addToSet: "$namespace" },
          count: { $sum: 1 },
          totalCpuNanos: { $sum: { $ifNull: ["$cpuNanos", 0] } },
          avgCpuNanos: { $avg: { $ifNull: ["$cpuNanos", 0] } },
          totalBytesRead: { $sum: { $ifNull: ["$bytesRead", 0] } },
          avgBytesRead: { $avg: { $ifNull: ["$bytesRead", 0] } },
          totalMillis: { $sum: "$millis" },
          avgMillis: { $avg: "$millis" },
          maxMillis: { $max: "$millis" },
          totalDocsExamined: { $sum: "$docsExamined" },
          totalKeysExamined: { $sum: "$keysExamined" },
          planSummaries: { $addToSet: "$planSummary" },
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

module.exports = router;
