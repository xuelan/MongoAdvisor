/**
 * Workload / sample-data scripts can target a different cluster than the MongoAdvisor app DB.
 * If `WORKLOAD_MONGO_URI` is set, use it; otherwise use `MONGO_URI`.
 */
function resolveWorkloadMongoUri() {
  const w = process.env.WORKLOAD_MONGO_URI;
  const m = process.env.MONGO_URI;
  if (w != null && String(w).trim()) return String(w).trim();
  if (m != null && String(m).trim()) return String(m).trim();
  return null;
}

module.exports = { resolveWorkloadMongoUri };
