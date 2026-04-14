#!/usr/bin/env node
/**
 * Encrypt a new connection string with ENCRYPTION_KEY from .env and write it to clusters.uri.
 *
 * Usage:
 *   node scripts/update-cluster-uri.js <cluster_id> "mongodb+srv://user:pass@host/..."
 *
 * Get <cluster_id> from the dashboard (browser devtools → Network → GET /api/clusters) or:
 *   mongosh "$MONGO_URI" --eval 'db.getSiblingDB("mongoadvisor").clusters.find({}, {_id:1,name:1}).pretty()'
 *
 * After updating, restart the MongoAdvisor server so pools reload (or use the dashboard **Edit connection & Atlas keys** for the same cluster to avoid a restart).
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { ObjectId } = require("mongodb");
const { connect, close, getDb } = require("../src/db");
const { encrypt } = require("../src/crypto");

async function main() {
  const id = process.argv[2];
  const uri = process.argv[3];
  if (!id || !uri) {
    console.error('Usage: node scripts/update-cluster-uri.js <cluster_id> "mongodb+srv://..."');
    process.exit(1);
  }

  await connect();
  try {
    const enc = encrypt(uri);
    const r = await getDb().collection("clusters").updateOne(
      { _id: new ObjectId(id) },
      { $set: { uri: enc } },
    );
    if (r.matchedCount === 0) {
      console.error("No cluster found with that _id.");
      process.exit(1);
    }
    console.log(`Updated clusters.uri (matched: ${r.matchedCount}, modified: ${r.modifiedCount})`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
