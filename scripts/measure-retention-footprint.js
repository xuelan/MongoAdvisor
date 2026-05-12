#!/usr/bin/env node
/**
 * Sizing report for the MongoAdvisor app database.
 *
 * Reads `collStats` and a few cheap aggregations from the application DB
 * (the one storing `query_stats`, `slow_queries`, `disk_usage`, `oplog_window`,
 * `monitor_logs`) and extrapolates per-day / per-week / per-month footprints
 * based on the observation window present in the data.
 *
 *   node scripts/measure-retention-footprint.js [--hours-observed N]
 *
 * Read-only. No writes, no schema changes. Safe to run any time.
 *
 * Background — see docs/retention.md for the closed-form model:
 *   query_stats   rows/day ≈ H × N × α × 288
 *   slow_queries  rows/day ≤ min(slow_rate × ops × 86400, H × 2000)
 *
 * This script measures the actual numbers so retention parameters can be
 * tuned without trusting the model.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");

const TIME_SERIES_COLLECTIONS = [
  "query_stats",
  "slow_queries",
  "disk_usage",
  "oplog_window",
  "monitor_logs",
];

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} k`;
  return String(Math.round(n));
}

function parseArgs(argv) {
  const out = { hoursObserved: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--hours-observed" && i + 1 < argv.length) {
      const v = parseFloat(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) out.hoursObserved = v;
      i++;
    }
  }
  return out;
}

async function collectionExists(db, name) {
  const list = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return list.length > 0;
}

async function measureCollection(db, coll, observedHoursOverride) {
  const exists = await collectionExists(db, coll);
  if (!exists) {
    return { coll, exists: false };
  }

  const stats = await db.command({ collStats: coll });
  const count = stats.count || 0;
  const sizeLogical = stats.size || 0;            // uncompressed BSON
  const storageSize = stats.storageSize || 0;     // compressed on disk
  const totalIndexSize = stats.totalIndexSize || 0;
  const avgObjSize = stats.avgObjSize || 0;

  let observedHours = observedHoursOverride;
  if (observedHours == null && count > 0) {
    // Derive the observation window from the earliest stored timestamp.
    // All five collections use a `timestamp` field of type Date.
    const oldest = await db
      .collection(coll)
      .find({ timestamp: { $exists: true } })
      .project({ timestamp: 1, _id: 0 })
      .sort({ timestamp: 1 })
      .limit(1)
      .next();
    if (oldest && oldest.timestamp instanceof Date) {
      const ms = Date.now() - oldest.timestamp.getTime();
      if (ms > 0) observedHours = ms / 3_600_000;
    }
  }

  const rowsPerHour = observedHours && observedHours > 0 ? count / observedHours : null;
  const compressionRatio = storageSize > 0 ? sizeLogical / storageSize : null;

  // Per-collection extras
  const extras = {};
  if (coll === "query_stats" && count > 0) {
    try {
      const distinctShapes = await db.collection(coll).distinct("queryShapeHash");
      extras.distinctShapes = distinctShapes.filter(Boolean).length;
    } catch { /* distinct may be too large; skip */ }
    try {
      const hosts = await db.collection(coll).distinct("host");
      extras.distinctHosts = hosts.filter(Boolean).length;
    } catch { /* skip */ }

    // Active fraction α: rows per (host × poll) ÷ distinct shapes per host.
    // Approximation: count distinct (host, queryShapeHash, hour) tuples and
    // divide by (distinctShapes × distinctHosts × hoursObserved). This is
    // bounded by 1 and reflects how many shapes advance latestSeenTimestamp
    // each poll.
    if (extras.distinctShapes && extras.distinctHosts && observedHours > 0) {
      const polls = (observedHours * 60) / 5; // 5-min poll cadence
      const expectedIfAllActive = extras.distinctShapes * extras.distinctHosts * polls;
      extras.alphaApprox = expectedIfAllActive > 0
        ? Math.min(1, count / expectedIfAllActive)
        : null;
    }
  }
  if (coll === "slow_queries" && count > 0) {
    try {
      const namespaces = await db.collection(coll).distinct("namespace");
      extras.distinctNamespaces = namespaces.filter(Boolean).length;
    } catch { /* skip */ }
    try {
      const queryHashes = await db.collection(coll).distinct("queryHash");
      extras.distinctQueryHashes = queryHashes.filter(Boolean).length;
    } catch { /* skip */ }
  }

  return {
    coll,
    exists: true,
    count,
    sizeLogical,
    storageSize,
    totalIndexSize,
    avgObjSize,
    observedHours,
    rowsPerHour,
    compressionRatio,
    extras,
  };
}

function printReport(report) {
  const { coll, exists } = report;
  console.log(`\n=== ${coll} ===`);
  if (!exists) {
    console.log("  (collection does not exist yet — has the collector run?)");
    return;
  }

  const {
    count, sizeLogical, storageSize, totalIndexSize, avgObjSize,
    observedHours, rowsPerHour, compressionRatio, extras,
  } = report;

  if (count === 0) {
    console.log("  (collection is empty — run a workload then re-measure)");
    return;
  }

  console.log(`  rows                  ${fmtNum(count)}`);
  console.log(`  avg BSON obj          ${fmtBytes(avgObjSize)}`);
  console.log(`  logical size          ${fmtBytes(sizeLogical)}`);
  console.log(`  storage (compressed)  ${fmtBytes(storageSize)}` +
    (compressionRatio ? `  (ratio ${compressionRatio.toFixed(1)}×)` : ""));
  console.log(`  index size            ${fmtBytes(totalIndexSize)}` +
    (sizeLogical > 0 ? `  (${((totalIndexSize / sizeLogical) * 100).toFixed(0)}% of data)` : ""));
  console.log(`  observation window    ${observedHours ? observedHours.toFixed(2) + " h" : "(unknown)"}`);
  if (rowsPerHour) console.log(`  rows/hour             ${fmtNum(rowsPerHour)}`);

  if (extras && Object.keys(extras).length) {
    console.log("  ── extras ──");
    if (extras.distinctShapes != null) console.log(`    distinct shapes     ${fmtNum(extras.distinctShapes)}`);
    if (extras.distinctHosts != null)  console.log(`    distinct hosts      ${extras.distinctHosts}`);
    if (extras.alphaApprox != null)    console.log(`    α (active fraction) ${extras.alphaApprox.toFixed(2)}`);
    if (extras.distinctNamespaces != null) console.log(`    distinct namespaces ${fmtNum(extras.distinctNamespaces)}`);
    if (extras.distinctQueryHashes != null) console.log(`    distinct queryHash  ${fmtNum(extras.distinctQueryHashes)}`);
  }

  if (rowsPerHour && observedHours >= 0.25) {
    // Only extrapolate when we have at least 15 min of data, otherwise the
    // numbers are dominated by startup transients.
    const perDay = rowsPerHour * 24;
    const dataPerDay = (sizeLogical / observedHours) * 24;
    const storagePerDay = (storageSize / observedHours) * 24;
    const idxPerDay = (totalIndexSize / observedHours) * 24;
    console.log("  ── linear projection ──");
    console.log(`    1 day  : ${fmtNum(perDay).padStart(8)} rows · ${fmtBytes(storagePerDay)} compressed · ${fmtBytes(idxPerDay)} indexes`);
    console.log(`    1 week : ${fmtNum(perDay * 7).padStart(8)} rows · ${fmtBytes(storagePerDay * 7)} compressed · ${fmtBytes(idxPerDay * 7)} indexes`);
    console.log(`    1 month: ${fmtNum(perDay * 30).padStart(8)} rows · ${fmtBytes(storagePerDay * 30)} compressed · ${fmtBytes(idxPerDay * 30)} indexes`);
    console.log(`    1 year : ${fmtNum(perDay * 365).padStart(8)} rows · ${fmtBytes(storagePerDay * 365)} compressed · ${fmtBytes(idxPerDay * 365)} indexes`);
  } else if (rowsPerHour) {
    console.log("  ── linear projection skipped: <15 min of observation, run workload longer and re-measure ──");
  }
}

function printTotals(reports) {
  const usable = reports.filter((r) => r.exists && r.count > 0 && r.rowsPerHour && r.observedHours >= 0.25);
  if (!usable.length) return;
  const sumStoragePerDay = usable.reduce((s, r) => s + (r.storageSize / r.observedHours) * 24, 0);
  const sumIdxPerDay = usable.reduce((s, r) => s + (r.totalIndexSize / r.observedHours) * 24, 0);
  console.log("\n=== totals across measured collections (raw hot tier) ===");
  console.log(`  1 day  : ${fmtBytes(sumStoragePerDay + sumIdxPerDay)}` +
    `  (data ${fmtBytes(sumStoragePerDay)} + indexes ${fmtBytes(sumIdxPerDay)})`);
  console.log(`  1 week : ${fmtBytes((sumStoragePerDay + sumIdxPerDay) * 7)}`);
  console.log(`  1 month: ${fmtBytes((sumStoragePerDay + sumIdxPerDay) * 30)}`);
  console.log(`  1 year : ${fmtBytes((sumStoragePerDay + sumIdxPerDay) * 365)}`);
  console.log("\nThese numbers are linear extrapolations of the observed window. Run the collector");
  console.log("with realistic workload for 6+ hours for the most reliable projection.");
}

async function main() {
  const { hoursObserved } = parseArgs(process.argv);

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set (.env or environment)");
    process.exit(1);
  }
  const dbName = process.env.MONGO_DB || "mongoadvisor";

  const client = new MongoClient(uri, {
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  try {
    await client.connect();
    const db = client.db(dbName);
    console.log(`Measuring retention footprint on database "${dbName}"`);
    if (hoursObserved) console.log(`(forced observation window: ${hoursObserved} h)`);

    const reports = [];
    for (const coll of TIME_SERIES_COLLECTIONS) {
      const r = await measureCollection(db, coll, hoursObserved);
      reports.push(r);
      printReport(r);
    }

    printTotals(reports);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
