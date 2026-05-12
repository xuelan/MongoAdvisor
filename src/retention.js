/**
 * Tiered retention for MongoAdvisor time-series collections.
 *
 *   Raw rows (query_stats, slow_queries, disk_usage, oplog_window, monitor_logs)
 *   are kept for RETENTION_RAW_DAYS (default 7) days, after which MongoDB TTL
 *   purges them automatically.
 *
 *   Before purge, an hourly rollup job aggregates each closed hour bucket into
 *   `<coll>_hourly` collections that survive long-term.
 *
 *   The job is idempotent: every rollup is an upsert keyed by the bucket start,
 *   so re-running the same hour is a no-op. A watermark in `retention_state`
 *   records progress so restarts resume.
 *
 *   See docs/retention.md for design rationale and tuning guidance.
 */
const { getDb } = require("./db");
const { logMonitorEvent } = require("./monitor-log");

// ─── Configuration ──────────────────────────────────────────────────

const RAW_TTL_DAYS         = parseInt(process.env.RETENTION_RAW_DAYS         || "7", 10);
const ROLLUP_TTL_DAYS      = parseInt(process.env.RETENTION_HOURLY_DAYS      || "0", 10); // 0 = never expire
const ROLLUP_INTERVAL_MS   = parseInt(process.env.ROLLUP_INTERVAL_MS         || `${60 * 60 * 1000}`, 10);
const ROLLUP_SAFETY_HOURS  = parseInt(process.env.ROLLUP_SAFETY_BUFFER_HOURS || "2", 10);
const RETENTION_ENABLED    = (process.env.RETENTION_ENABLED || "true") !== "false";

/** TTL on raw is RAW_TTL_DAYS + 1 day buffer so rollup always sees a full closed
 *  hour even if the job is briefly stalled. */
const RAW_TTL_SECONDS    = (RAW_TTL_DAYS + 1) * 86400;
const ROLLUP_TTL_SECONDS = ROLLUP_TTL_DAYS > 0 ? ROLLUP_TTL_DAYS * 86400 : null;

const RETENTION_STATE = "retention_state";
const WATERMARK_ID    = "watermark";

// ─── Collection name constants ──────────────────────────────────────

const QUERY_STATS         = "query_stats";
const SLOW_QUERIES        = "slow_queries";
const DISK_USAGE          = "disk_usage";
const OPLOG_WINDOW        = "oplog_window";
const MONITOR_LOGS        = "monitor_logs";

const QUERY_STATS_HOURLY  = "query_stats_hourly";
const SLOW_QUERIES_HOURLY = "slow_queries_hourly";
const DISK_USAGE_HOURLY   = "disk_usage_hourly";
const OPLOG_WINDOW_HOURLY = "oplog_window_hourly";

// ─── Helpers ────────────────────────────────────────────────────────

function floorToHour(d) {
  const x = new Date(d);
  x.setUTCMinutes(0, 0, 0);
  return x;
}

function addHours(d, n) {
  const x = new Date(d);
  x.setUTCHours(x.getUTCHours() + n);
  return x;
}

/** Sum of positive deltas between consecutive cumulative-counter snapshots.
 *  Negative steps (server restart / metrics-store eviction) reset to the new
 *  value as the start of a new series. */
function sumPositiveDeltas(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  let total = 0;
  let prev = null;
  for (const raw of values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      total += v;             // first snapshot in series → counter value so far
    } else if (v >= prev) {
      total += v - prev;      // monotonic growth
    } else {
      total += v;             // counter reset → restart the series
    }
    prev = v;
  }
  return total;
}

// ─── Index setup ────────────────────────────────────────────────────

/**
 * Idempotent: createIndex returns the existing name if the spec matches.
 * TTL must be on a single-field index, so we keep it separate from the
 * existing compound unique indexes.
 */
async function ensureRetentionIndexes() {
  const db = getDb();
  const tasks = [];

  // Raw TTL indexes
  for (const coll of [QUERY_STATS, SLOW_QUERIES, DISK_USAGE, OPLOG_WINDOW, MONITOR_LOGS]) {
    tasks.push(
      db.collection(coll).createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: RAW_TTL_SECONDS, name: "ttl_timestamp" },
      ),
    );
  }

  // Rollup collection unique keys + secondary indexes for dashboard reads
  tasks.push(
    db.collection(QUERY_STATS_HOURLY).createIndex(
      { clusterId: 1, host: 1, queryShapeHash: 1, bucketStart: 1 },
      { unique: true, name: "uniq_query_stats_hourly_bucket" },
    ),
    db.collection(QUERY_STATS_HOURLY).createIndex(
      { clusterId: 1, namespace: 1, bucketStart: -1 },
      { name: "query_stats_hourly_cluster_ns_time" },
    ),
    db.collection(SLOW_QUERIES_HOURLY).createIndex(
      { clusterId: 1, host: 1, queryHash: 1, planSummary: 1, bucketStart: 1 },
      { unique: true, name: "uniq_slow_queries_hourly_bucket" },
    ),
    db.collection(SLOW_QUERIES_HOURLY).createIndex(
      { clusterId: 1, appName: 1, comment: 1, bucketStart: -1 },
      { name: "slow_queries_hourly_app_comment" },
    ),
    db.collection(DISK_USAGE_HOURLY).createIndex(
      { clusterId: 1, bucketStart: 1 },
      { unique: true, name: "uniq_disk_usage_hourly_bucket" },
    ),
    db.collection(OPLOG_WINDOW_HOURLY).createIndex(
      { clusterId: 1, bucketStart: 1 },
      { unique: true, name: "uniq_oplog_window_hourly_bucket" },
    ),
  );

  // Optional TTL on rollups (off by default — 0 means keep forever)
  if (ROLLUP_TTL_SECONDS != null) {
    for (const coll of [QUERY_STATS_HOURLY, SLOW_QUERIES_HOURLY, DISK_USAGE_HOURLY, OPLOG_WINDOW_HOURLY]) {
      tasks.push(
        db.collection(coll).createIndex(
          { bucketStart: 1 },
          { expireAfterSeconds: ROLLUP_TTL_SECONDS, name: "ttl_bucketStart" },
        ),
      );
    }
  }

  await Promise.all(tasks);
  console.log(
    `[retention] indexes ensured (raw TTL ${RAW_TTL_DAYS + 1}d, ` +
    `hourly TTL ${ROLLUP_TTL_SECONDS != null ? `${ROLLUP_TTL_DAYS}d` : "off"})`,
  );
}

// ─── Watermark ──────────────────────────────────────────────────────

async function readWatermark() {
  const doc = await getDb().collection(RETENTION_STATE).findOne({ _id: WATERMARK_ID });
  return doc?.lastRolledUpHour instanceof Date ? doc.lastRolledUpHour : null;
}

async function writeWatermark(hour) {
  await getDb().collection(RETENTION_STATE).updateOne(
    { _id: WATERMARK_ID },
    { $set: { lastRolledUpHour: hour, updatedAt: new Date() } },
    { upsert: true },
  );
}

/** Earliest stored timestamp across all raw time-series; used to seed the
 *  initial watermark for backfill on first run. */
async function earliestRawTimestamp() {
  const db = getDb();
  const colls = [QUERY_STATS, SLOW_QUERIES, DISK_USAGE, OPLOG_WINDOW];
  const candidates = await Promise.all(
    colls.map(async (c) => {
      try {
        const r = await db.collection(c).find({ timestamp: { $exists: true } })
          .project({ timestamp: 1 }).sort({ timestamp: 1 }).limit(1).next();
        return r?.timestamp instanceof Date ? r.timestamp : null;
      } catch { return null; }
    }),
  );
  const valid = candidates.filter(Boolean);
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

// ─── Rollups ────────────────────────────────────────────────────────

/**
 * query_stats rollup — delta-fold of cumulative counters.
 *
 * Within one hour, each (clusterId, host, keyHash, queryShapeHash) series is
 * sorted by timestamp; we sum the positive deltas of `execCount`,
 * `totalExecMicros`, `docsExamined`, `keysExamined`. firstResponseExecMicros
 * min/max/sum/sumOfSquares are folded as themselves (already shape-aggregated
 * by $queryStats — summing them across snapshots overstates, so we min/max
 * the min/max and take the max for sum/sumOfSquares as a conservative bound).
 *
 * For UI continuity we keep the last `queryShape`/`namespace`/`appName`/`comment`
 * seen in the bucket.
 */
async function rollupQueryStatsHour(bucketStart) {
  const bucketEnd = addHours(bucketStart, 1);
  const db = getDb();

  const cursor = db.collection(QUERY_STATS).aggregate([
    { $match: { timestamp: { $gte: bucketStart, $lt: bucketEnd } } },
    { $sort: { clusterId: 1, host: 1, keyHash: 1, queryShapeHash: 1, timestamp: 1 } },
    {
      $group: {
        _id: {
          clusterId: "$clusterId",
          host: "$host",
          keyHash: "$keyHash",
          queryShapeHash: "$queryShapeHash",
        },
        clusterName:    { $last: "$clusterName" },
        appName:        { $last: "$appName" },
        namespace:      { $last: "$namespace" },
        comment:        { $last: "$comment" },
        queryShape:     { $last: "$queryShape" },
        execCounts:     { $push: "$execCount" },
        totalMicros:    { $push: "$totalExecMicros" },
        docs:           { $push: "$docsExamined" },
        keys:           { $push: "$keysExamined" },
        frMin:          { $min: "$firstResponseExecMicros.min" },
        frMax:          { $max: "$firstResponseExecMicros.max" },
        frSum:          { $max: "$firstResponseExecMicros.sum" },
        frSumSq:        { $max: "$firstResponseExecMicros.sumOfSquares" },
        lastExecMax:    { $max: "$lastExecutionMicros" },
        observations:   { $sum: 1 },
      },
    },
  ], { allowDiskUse: true });

  const ops = [];
  const rolledUpAt = new Date();
  for await (const row of cursor) {
    const execCount       = sumPositiveDeltas(row.execCounts);
    const totalExecMicros = sumPositiveDeltas(row.totalMicros);
    const docsExamined    = sumPositiveDeltas(row.docs);
    const keysExamined    = sumPositiveDeltas(row.keys);

    const doc = {
      bucketStart,
      bucketEnd,
      clusterId:      row._id.clusterId,
      clusterName:    row.clusterName ?? null,
      host:           row._id.host,
      keyHash:        row._id.keyHash ?? null,
      queryShapeHash: row._id.queryShapeHash,
      appName:        row.appName ?? null,
      namespace:      row.namespace ?? null,
      comment:        row.comment ?? null,
      queryShapeSample: row.queryShape ?? null,
      observationCount: row.observations,
      execCount,
      totalExecMicros,
      docsExamined,
      keysExamined,
      firstResponseExecMicros: {
        min: row.frMin ?? 0,
        max: row.frMax ?? 0,
        sum: row.frSum ?? 0,
        sumOfSquares: row.frSumSq ?? 0,
      },
      lastExecutionMicrosMax: row.lastExecMax ?? 0,
      rolledUpAt,
    };

    ops.push({
      updateOne: {
        filter: {
          clusterId: doc.clusterId,
          host: doc.host,
          queryShapeHash: doc.queryShapeHash,
          bucketStart: doc.bucketStart,
        },
        update: { $set: doc },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await db.collection(QUERY_STATS_HOURLY).bulkWrite(ops, { ordered: false });
  }
  return ops.length;
}

/**
 * slow_queries rollup — per-event aggregates.
 *
 * Slow-query rows are individual events, so we group by
 * (clusterId, host, queryHash, planSummary) and sum counts. We preserve one
 * exemplar per bucket (the slowest by millis) so the explain popup still
 * works after raw is purged.
 */
async function rollupSlowQueriesHour(bucketStart) {
  const bucketEnd = addHours(bucketStart, 1);
  const db = getDb();

  const cursor = db.collection(SLOW_QUERIES).aggregate([
    { $match: { timestamp: { $gte: bucketStart, $lt: bucketEnd } } },
    { $sort: { millis: -1 } }, // for $first → exemplar
    {
      $group: {
        _id: {
          clusterId: "$clusterId",
          host: "$host",
          queryHash: "$queryHash",
          planSummary: "$planSummary",
        },
        clusterName:    { $first: "$clusterName" },
        appName:        { $first: "$appName" },
        namespace:      { $first: "$namespace" },
        comment:        { $first: "$comment" },
        count:          { $sum: 1 },
        totalMillis:    { $sum: "$millis" },
        avgMillis:      { $avg: "$millis" },
        maxMillis:      { $max: "$millis" },
        totalCpuNanos:  { $sum: { $ifNull: ["$cpuNanos", 0] } },
        totalBytesRead: { $sum: { $ifNull: ["$bytesRead", 0] } },
        totalDocsExamined: { $sum: "$docsExamined" },
        totalKeysExamined: { $sum: "$keysExamined" },
        totalNreturned: { $sum: "$nreturned" },
        // Exemplar: the slowest op in the bucket
        exemplarTimestamp: { $first: "$timestamp" },
        exemplarMillis:    { $first: "$millis" },
        exemplarCommand:   { $first: "$command" },
        exemplarOriginatingCommand: { $first: "$originatingCommand" },
        exemplarRaw:       { $first: "$raw" },
      },
    },
  ], { allowDiskUse: true });

  const ops = [];
  const rolledUpAt = new Date();
  for await (const row of cursor) {
    const doc = {
      bucketStart,
      bucketEnd,
      clusterId:    row._id.clusterId,
      clusterName:  row.clusterName ?? null,
      host:         row._id.host,
      queryHash:    row._id.queryHash ?? null,
      planSummary:  row._id.planSummary ?? null,
      appName:      row.appName ?? null,
      namespace:    row.namespace ?? null,
      comment:      row.comment ?? null,
      count:        row.count,
      totalMillis:  row.totalMillis,
      avgMillis:    row.avgMillis,
      maxMillis:    row.maxMillis,
      totalCpuNanos:    row.totalCpuNanos,
      totalBytesRead:   row.totalBytesRead,
      totalDocsExamined: row.totalDocsExamined,
      totalKeysExamined: row.totalKeysExamined,
      totalNreturned:    row.totalNreturned,
      exemplar: {
        timestamp:           row.exemplarTimestamp ?? bucketStart,
        millis:              row.exemplarMillis ?? 0,
        command:             row.exemplarCommand ?? null,
        originatingCommand:  row.exemplarOriginatingCommand ?? null,
        raw: typeof row.exemplarRaw === "string" ? row.exemplarRaw.slice(0, 4000) : null,
      },
      rolledUpAt,
    };

    ops.push({
      updateOne: {
        filter: {
          clusterId: doc.clusterId,
          host: doc.host,
          queryHash: doc.queryHash,
          planSummary: doc.planSummary,
          bucketStart: doc.bucketStart,
        },
        update: { $set: doc },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await db.collection(SLOW_QUERIES_HOURLY).bulkWrite(ops, { ordered: false });
  }
  return ops.length;
}

async function rollupDiskUsageHour(bucketStart) {
  const bucketEnd = addHours(bucketStart, 1);
  const db = getDb();

  const cursor = db.collection(DISK_USAGE).aggregate([
    { $match: { timestamp: { $gte: bucketStart, $lt: bucketEnd } } },
    {
      $group: {
        _id: "$clusterId",
        clusterName:        { $last: "$clusterName" },
        fsTotalMin:         { $min: "$fsTotalSizeBytes" },
        fsTotalMax:         { $max: "$fsTotalSizeBytes" },
        fsTotalAvg:         { $avg: "$fsTotalSizeBytes" },
        fsUsedMin:          { $min: "$fsUsedSizeBytes" },
        fsUsedMax:          { $max: "$fsUsedSizeBytes" },
        fsUsedAvg:          { $avg: "$fsUsedSizeBytes" },
        usagePctMin:        { $min: "$usagePct" },
        usagePctMax:        { $max: "$usagePct" },
        usagePctAvg:        { $avg: "$usagePct" },
        samples:            { $sum: 1 },
      },
    },
  ]);

  const ops = [];
  const rolledUpAt = new Date();
  for await (const row of cursor) {
    ops.push({
      updateOne: {
        filter: { clusterId: row._id, bucketStart },
        update: {
          $set: {
            bucketStart, bucketEnd,
            clusterId: row._id,
            clusterName: row.clusterName ?? null,
            fsTotalSizeBytes: { min: row.fsTotalMin, max: row.fsTotalMax, avg: row.fsTotalAvg },
            fsUsedSizeBytes:  { min: row.fsUsedMin,  max: row.fsUsedMax,  avg: row.fsUsedAvg },
            usagePct:         { min: row.usagePctMin, max: row.usagePctMax, avg: row.usagePctAvg },
            samples: row.samples,
            rolledUpAt,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await db.collection(DISK_USAGE_HOURLY).bulkWrite(ops, { ordered: false });
  }
  return ops.length;
}

async function rollupOplogWindowHour(bucketStart) {
  const bucketEnd = addHours(bucketStart, 1);
  const db = getDb();

  const cursor = db.collection(OPLOG_WINDOW).aggregate([
    { $match: { timestamp: { $gte: bucketStart, $lt: bucketEnd } } },
    {
      $group: {
        _id: "$clusterId",
        clusterName:    { $last: "$clusterName" },
        windowHoursMin: { $min: "$windowHours" },
        windowHoursMax: { $max: "$windowHours" },
        windowHoursAvg: { $avg: "$windowHours" },
        oldestTs:       { $min: "$oldestTs" },
        newestTs:       { $max: "$newestTs" },
        samples:        { $sum: 1 },
      },
    },
  ]);

  const ops = [];
  const rolledUpAt = new Date();
  for await (const row of cursor) {
    ops.push({
      updateOne: {
        filter: { clusterId: row._id, bucketStart },
        update: {
          $set: {
            bucketStart, bucketEnd,
            clusterId: row._id,
            clusterName: row.clusterName ?? null,
            windowHours: { min: row.windowHoursMin, max: row.windowHoursMax, avg: row.windowHoursAvg },
            oldestTs: row.oldestTs ?? null,
            newestTs: row.newestTs ?? null,
            samples: row.samples,
            rolledUpAt,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await db.collection(OPLOG_WINDOW_HOURLY).bulkWrite(ops, { ordered: false });
  }
  return ops.length;
}

// ─── Driver ─────────────────────────────────────────────────────────

async function rollupHour(bucketStart) {
  const [qs, sq, du, ow] = await Promise.all([
    rollupQueryStatsHour(bucketStart),
    rollupSlowQueriesHour(bucketStart),
    rollupDiskUsageHour(bucketStart),
    rollupOplogWindowHour(bucketStart),
  ]);
  return { queryStats: qs, slowQueries: sq, diskUsage: du, oplogWindow: ow };
}

/** Roll up every closed hour between (watermark, now - safety_buffer]. Idempotent. */
async function runRollupOnce() {
  if (!RETENTION_ENABLED) return { skipped: "disabled" };

  let watermark = await readWatermark();
  if (watermark == null) {
    const earliest = await earliestRawTimestamp();
    if (!earliest) return { skipped: "no_data" };
    // Start one hour *before* the earliest raw row so its bucket gets rolled up.
    watermark = addHours(floorToHour(earliest), -1);
  }

  const horizon = addHours(floorToHour(new Date()), -ROLLUP_SAFETY_HOURS);
  if (watermark >= horizon) return { skipped: "up_to_date", watermark, horizon };

  let cur = addHours(watermark, 1);
  const totals = { hoursProcessed: 0, queryStats: 0, slowQueries: 0, diskUsage: 0, oplogWindow: 0 };
  const startedAt = Date.now();

  while (cur <= horizon) {
    try {
      const r = await rollupHour(cur);
      totals.hoursProcessed += 1;
      totals.queryStats += r.queryStats;
      totals.slowQueries += r.slowQueries;
      totals.diskUsage += r.diskUsage;
      totals.oplogWindow += r.oplogWindow;
      await writeWatermark(cur);
    } catch (err) {
      console.error(`[retention] hour ${cur.toISOString()} failed:`, err.message);
      await logMonitorEvent({
        action: "retention.rollup",
        outcome: "error",
        targetCollection: "retention_state",
        detail: `hour ${cur.toISOString()} failed`,
        error: err.message,
      });
      // Stop here — next tick will retry the same hour rather than skipping it.
      return { ...totals, stoppedAt: cur, error: err.message };
    }
    cur = addHours(cur, 1);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[retention] rolled up ${totals.hoursProcessed}h in ${(elapsedMs / 1000).toFixed(1)}s — ` +
    `qs=${totals.queryStats} sq=${totals.slowQueries} du=${totals.diskUsage} ow=${totals.oplogWindow}`,
  );
  await logMonitorEvent({
    action: "retention.rollup",
    outcome: totals.hoursProcessed > 0 ? "ok" : "skipped",
    targetCollection: "retention_state",
    detail: totals.hoursProcessed > 0
      ? `rolled up ${totals.hoursProcessed} hour bucket(s)`
      : "no closed buckets to roll up",
    meta: totals,
  });

  return totals;
}

// ─── Lifecycle ──────────────────────────────────────────────────────

let rollupTimer = null;

function startRetention() {
  if (!RETENTION_ENABLED) {
    console.log("[retention] disabled (RETENTION_ENABLED=false)");
    return;
  }
  console.log(
    `[retention] starting: raw=${RAW_TTL_DAYS}d, rollup interval=${ROLLUP_INTERVAL_MS / 60000}min, ` +
    `safety buffer=${ROLLUP_SAFETY_HOURS}h, hourly TTL=${ROLLUP_TTL_SECONDS != null ? `${ROLLUP_TTL_DAYS}d` : "off"}`,
  );

  // Initial pass shortly after boot so backfill kicks in without waiting an hour.
  setTimeout(() => {
    runRollupOnce().catch((err) => console.error("[retention] initial rollup error:", err.message));
  }, 30_000);

  rollupTimer = setInterval(() => {
    runRollupOnce().catch((err) => console.error("[retention] rollup error:", err.message));
  }, ROLLUP_INTERVAL_MS);
}

function stopRetention() {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
}

// ─── Public read-side helpers ────────────────────────────────────────

/** Cutoff between "raw is reliable" and "use the rollup". Used by API routes. */
function rawHotCutoff() {
  return new Date(Date.now() - RAW_TTL_DAYS * 86_400_000);
}

module.exports = {
  ensureRetentionIndexes,
  startRetention,
  stopRetention,
  runRollupOnce,
  rollupHour,
  rawHotCutoff,
  // Exported for unit/manual testing
  _internal: {
    sumPositiveDeltas,
    floorToHour,
    addHours,
    readWatermark,
    writeWatermark,
    earliestRawTimestamp,
    QUERY_STATS_HOURLY,
    SLOW_QUERIES_HOURLY,
    DISK_USAGE_HOURLY,
    OPLOG_WINDOW_HOURLY,
  },
  RAW_TTL_DAYS,
  RETENTION_ENABLED,
  COLLECTIONS: {
    QUERY_STATS_HOURLY,
    SLOW_QUERIES_HOURLY,
    DISK_USAGE_HOURLY,
    OPLOG_WINDOW_HOURLY,
    RETENTION_STATE,
  },
};
