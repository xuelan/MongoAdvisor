#!/usr/bin/env node
/**
 * Creates recommended indexes on the MongoAdvisor application database (MONGO_URI / MONGO_DB).
 * Run manually when deploying or after schema changes — not invoked by npm start / the server.
 *
 *   node scripts/ensure-indexes.js
 *   npm run indexes:ensure
 *
 * Requires .env with MONGO_URI (and optional MONGO_DB, default mongoadvisor).
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");

const INDEXES = [
  {
    coll: "query_stats",
    keys: { clusterId: 1, host: 1, timestamp: 1, keyHash: 1, queryShapeHash: 1 },
    options: { unique: true, name: "uniq_query_stats_observation" },
  },
  {
    coll: "slow_queries",
    keys: { clusterId: 1, host: 1, id: 1, timestamp: 1, millis: 1, ctx: 1 },
    options: {
      unique: true,
      name: "uniq_slow_log_dedupe",
      partialFilterExpression: { id: { $type: ["int", "long", "double"] } },
    },
  },
  {
    /** Backs the per-host watermark lookup (find({clusterId,host}).sort({timestamp:-1}).limit(1))
     *  used by the slow-query collector to size the Atlas `since` parameter. */
    coll: "slow_queries",
    keys: { clusterId: 1, host: 1, timestamp: -1 },
    options: { name: "slow_queries_cluster_host_time" },
  },
  {
    coll: "topologies",
    keys: { clusterId: 1 },
    options: { unique: true, name: "uniq_topology_per_cluster" },
  },
  {
    coll: "monitor_logs",
    keys: { timestamp: -1 },
    options: { name: "monitor_logs_timestamp" },
  },
  {
    coll: "index_stats",
    keys: { clusterId: 1, type: 1, host: 1, namespace: 1 },
    options: { name: "index_stats_cluster_type_host_ns" },
  },
  {
    coll: "storage_stats",
    keys: { clusterId: 1, namespace: 1 },
    options: { name: "storage_stats_cluster_ns" },
  },
  {
    coll: "disk_usage",
    keys: { clusterId: 1, timestamp: -1 },
    options: { name: "disk_usage_cluster_time" },
  },
  {
    coll: "oplog_window",
    keys: { clusterId: 1, timestamp: -1 },
    options: { name: "oplog_window_cluster_time" },
  },
];

async function main() {
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
  let failed = false;
  try {
    await client.connect();
    const db = client.db(dbName);
    console.log(`Ensuring indexes on database "${dbName}"…\n`);
    for (const { coll, keys, options } of INDEXES) {
      try {
        const name = await db.collection(coll).createIndex(keys, options);
        console.log(`  OK  ${coll}  →  ${name}`);
      } catch (e) {
        failed = true;
        console.error(`  FAIL ${coll} (${options.name || "index"}): ${e.message}`);
      }
    }
  } finally {
    await client.close();
  }
  if (failed) {
    console.error("\nSome indexes failed (duplicates or conflicting index names are common). Fix data or drop old indexes, then re-run.");
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
