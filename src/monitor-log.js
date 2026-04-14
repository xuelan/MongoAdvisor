const { getDb } = require("./db");

const MONITOR_LOGS = "monitor_logs";

/**
 * Append one row to `monitor_logs` (application DB). Never throws — failures only log to stderr.
 * @param {object} p
 * @param {"collector"|"discovery"|"api"} [p.source]
 * @param {string} p.action — short verb, e.g. queryStats.collect, cluster.create
 * @param {"ok"|"error"|"skipped"} [p.outcome]
 * @param {import("mongodb").ObjectId} [p.clusterId]
 * @param {string} [p.clusterName]
 * @param {string} [p.targetCollection] — destination collection when relevant
 * @param {string} [p.detail] — human-readable summary
 * @param {object} [p.meta] — small JSON-safe payload (counts, etc.)
 * @param {string} [p.error] — when outcome is error
 */
async function logMonitorEvent(p) {
  try {
    const doc = {
      timestamp: new Date(),
      source: p.source || "collector",
      action: p.action,
      outcome: p.outcome || "ok",
    };
    if (p.clusterId != null) doc.clusterId = p.clusterId;
    if (p.clusterName) doc.clusterName = p.clusterName;
    if (p.targetCollection) doc.targetCollection = p.targetCollection;
    if (p.detail != null) doc.detail = String(p.detail).slice(0, 4000);
    if (p.meta != null && typeof p.meta === "object") doc.meta = p.meta;
    if (p.error) doc.error = String(p.error).slice(0, 2000);
    await getDb().collection(MONITOR_LOGS).insertOne(doc);
  } catch (e) {
    console.error("[monitor_logs] write failed:", e.message);
  }
}

module.exports = { logMonitorEvent, MONITOR_LOGS };
