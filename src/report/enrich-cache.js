/**
 * Backfill per-collection WiredTiger cache bytes into a report document when the
 * normalized payload is missing `wiredTiger.cache` (e.g. older slim/embed paths or
 * captures that only retained block-manager stats).
 *
 * Source: getMongoData `collection_stats` sections in `reports_raw` EJSON.
 */

const { parse } = require("./parser");

const CACHE_IN = "bytes currently in the cache";

function collectionStatsNs(output) {
  if (!output || typeof output !== "object") return null;
  if (typeof output.ns === "string") return output.ns;
  if (output.shards && typeof output.shards === "object") {
    const first = Object.values(output.shards)[0];
    if (first?.ns) return first.ns;
  }
  return null;
}

function wiredTigerCacheBytes(wt) {
  const n = Number(wt?.cache?.[CACHE_IN]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build a map of namespace → cache bytes from one or more raw getMongoData files.
 * @param {string[]} rawEjsonTexts
 * @returns {Map<string, number>}
 */
function cacheBytesByNsFromRaw(rawEjsonTexts) {
  const map = new Map();
  for (const text of rawEjsonTexts || []) {
    if (!text || typeof text !== "string") continue;
    let sections;
    try {
      sections = parse(text);
    } catch {
      continue;
    }
    for (const doc of sections) {
      if (doc?.section !== "data_info") continue;
      const sub = String(doc.subsection || "");
      if (!sub.startsWith("collection_stats")) continue;
      const out = doc.output;
      if (!out || typeof out !== "object") continue;

      const recordNs = (stats) => {
        const ns = collectionStatsNs(stats) || collectionStatsNs(out);
        if (!ns) return;
        const bytes = wiredTigerCacheBytes(stats?.wiredTiger);
        if (bytes <= 0) return;
        const prev = map.get(ns) || 0;
        if (bytes > prev) map.set(ns, bytes);
      };

      recordNs(out);
      if (out.shards && typeof out.shards === "object") {
        for (const shardStats of Object.values(out.shards)) {
          recordNs(shardStats);
        }
      }
    }
  }
  return map;
}

/**
 * @param {object} reportDoc
 * @param {string[]} [rawEjsonTexts]
 * @returns {object} shallow-cloned report with cache merged where missing
 */
function enrichNormalizedCache(reportDoc, rawEjsonTexts) {
  const cacheByNs = cacheBytesByNsFromRaw(rawEjsonTexts);
  if (cacheByNs.size === 0) return reportDoc;

  const out = JSON.parse(JSON.stringify(reportDoc));
  for (const entry of out.normalized || []) {
    const n = entry.normalized;
    if (!n) continue;
    for (const db of n.databases || []) {
      for (const coll of db.collections || []) {
        if (!coll.stats) continue;
        const ns = coll.stats.ns || `${db.name}.${coll.name}`;
        const bytes = cacheByNs.get(ns);
        if (!bytes) continue;
        if (wiredTigerCacheBytes(coll.stats.wiredTiger) > 0) continue;
        coll.stats.wiredTiger = coll.stats.wiredTiger || {};
        coll.stats.wiredTiger.cache = { [CACHE_IN]: bytes };
      }
    }
  }
  return out;
}

module.exports = {
  cacheBytesByNsFromRaw,
  enrichNormalizedCache,
  CACHE_IN,
};
