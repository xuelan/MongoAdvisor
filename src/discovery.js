const dns = require("dns").promises;
const { getDb } = require("./db");
const { ensureConnected } = require("./pool-cache");
const { decrypt, isEncrypted } = require("./crypto");
const { logMonitorEvent } = require("./monitor-log");
const { isClusterPollingEnabled } = require("./cluster-polling");
const { isHiddenTopLevelDb } = require("./hidden-dbs");

const TOPOLOGIES = "topologies";
const CLUSTERS = "clusters";

/** Threshold above which per-collection scans (storageStats, indexStats) are skipped to protect
 *  the cluster from a heavy `collStats` / `$indexStats` sweep across thousands of namespaces.
 *  See https://www.mongodb.com/docs/manual/data-modeling/design-antipatterns/reduce-collections/ */
const CATALOG_TOO_LARGE_THRESHOLD = 10_000;

/** Per MongoDB manual, the `$queryStats` stage returns statistics for recorded queries starting in 7.1.
 *  See https://www.mongodb.com/docs/manual/reference/operator/aggregation/queryStats/ */
const QUERY_STATS_MIN_MAJOR = 7;
const QUERY_STATS_MIN_MINOR = 1;

/** True when versionArray is at least [QUERY_STATS_MIN_MAJOR, QUERY_STATS_MIN_MINOR, 0]. */
function supportsQueryStats(versionArray) {
  if (!Array.isArray(versionArray) || versionArray.length === 0) return null;
  const major = Number(versionArray[0]);
  const minor = Number(versionArray[1] ?? 0);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (major > QUERY_STATS_MIN_MAJOR) return true;
  if (major < QUERY_STATS_MIN_MAJOR) return false;
  return minor >= QUERY_STATS_MIN_MINOR;
}

function decryptUri(uri) {
  return uri && isEncrypted(uri) ? decrypt(uri) : uri;
}

/**
 * Resolve SRV records for an Atlas `mongodb+srv://` URI.
 * Returns `["host:port", ...]` or `[]` on any error.
 */
async function resolveSrvHosts(uri) {
  if (!uri || !uri.startsWith("mongodb+srv://")) return [];
  try {
    const sanitized = uri.replace(/\/\/[^@]+@/, "//x@");
    const hostname = new URL(sanitized).hostname;
    const records = await dns.resolveSrv(`_mongodb._tcp.${hostname}`);
    return records.map((r) => `${r.name}:${r.port}`);
  } catch {
    return [];
  }
}

/**
 * Extract the shard-number suffix from an Atlas hostname.
 * e.g. "<cluster>-shard-00-01.<tenant>.mongodb.net:27017" → "shard-00-01"
 */
function shardSuffix(host) {
  const m = host && host.match(/(shard-\d+-\d+)/);
  return m ? m[1] : null;
}

/**
 * Map a host from `hello.hosts` format to the equivalent SRV host by matching shard suffix.
 * Returns null when no match is found.
 */
function mapToSrvHost(helloHost, srvHosts) {
  const suffix = shardSuffix(helloHost);
  if (!suffix) return null;
  return srvHosts.find((h) => h.includes(suffix)) || null;
}

async function discoverOne(cluster) {
  // Step 1: Resolve SRV hostnames from URI first — works even if MongoDB auth/connection fails,
  // so the topology display is always correct after a URI update.
  const rawUri = decryptUri(cluster.uri);
  const srvHosts = await resolveSrvHosts(rawUri);
  const uriPrefix = rawUri
    ? (() => { try { return new URL(rawUri.replace(/\/\/[^@]+@/, "//x@")).hostname.split(".")[0]; } catch { return null; } })()
    : null;

  // Step 2: Try the live `hello` command for setName / primary detection.
  let hello = null;
  let helloError = null;
  try {
    const client = await ensureConnected(cluster);
    hello = await client.db("admin").command({ hello: 1 });
  } catch (err) {
    helloError = err;
    if (!srvHosts.length) {
      // No SRV fallback either — propagate so caller logs the error.
      throw err;
    }
    console.warn(
      `[discovery] ${cluster.name}: hello() failed (${err.message}); using SRV-resolved hostnames as topology fallback`,
    );
  }

  const rawHosts = hello?.hosts || [];
  const rawPrimary = hello?.primary || null;

  let canonicalHosts;
  let canonicalPrimary;

  if (srvHosts.length > 0) {
    const rsPrefix = rawHosts[0] ? rawHosts[0].split("-shard-")[0] : null;
    const helloMatchesUri = uriPrefix && rsPrefix && uriPrefix === rsPrefix;
    if (!hello || !helloMatchesUri) {
      // Either hello failed, or hello returns a different cluster's internal RS names — prefer SRV
      canonicalHosts = srvHosts;
      canonicalPrimary = rawPrimary ? (mapToSrvHost(rawPrimary, srvHosts) || null) : null;
      console.log(
        `[discovery] ${cluster.name}: SRV resolved ${srvHosts.length} canonical host(s) (uri="${uriPrefix}-*"${rsPrefix ? `, rs="${rsPrefix}-*"` : ""}) primary=${canonicalPrimary || "(unknown — hello failed or unmapped)"}`,
      );
    } else {
      canonicalHosts = rawHosts;
      canonicalPrimary = rawPrimary;
    }
  } else {
    // No SRV (e.g. non-SRV URI). Fall back to hello (or empty if hello failed too — already thrown above).
    canonicalHosts = rawHosts;
    canonicalPrimary = rawPrimary;
  }

  // Step 3: When the live connection works, fetch catalog stats + database list + buildInfo.
  // - serverStatus.catalogStats.collections gates per-collection scans (storage / indexStats).
  // - listDatabases populates the topology.databases used by the UI Databases filter.
  // - buildInfo.versionArray gates $queryStats (manual: stage from MongoDB 7.1+).
  let catalogStats = null;
  let catalogTooLarge = false;
  let catalogError = null;
  let databases = [];
  let serverVersion = null;
  let serverVersionArray = null;
  let queryStatsSupported = null;
  if (hello && !helloError) {
    try {
      const client = await ensureConnected(cluster);
      const ss = await client
        .db("admin")
        .command({ serverStatus: 1, catalogStats: 1 });
      const cs = ss?.catalogStats || null;
      if (cs) {
        catalogStats = {
          collections: cs.collections || 0,
          views: cs.views || 0,
          clustered: cs.clustered || 0,
          timeseries: cs.timeseries || 0,
          internalCollections: cs.internalCollections || 0,
          total: cs.total || (cs.collections || 0) + (cs.views || 0),
        };
        catalogTooLarge = (cs.collections || 0) > CATALOG_TOO_LARGE_THRESHOLD;
      }

      // buildInfo is cheap and cluster-wide, so we always run it (regardless of catalog size).
      try {
        const bi = await client.db("admin").command({ buildInfo: 1 });
        serverVersion = bi?.version || null;
        serverVersionArray = Array.isArray(bi?.versionArray) ? bi.versionArray : null;
        queryStatsSupported = supportsQueryStats(serverVersionArray);
      } catch (err) {
        console.warn(`[discovery] ${cluster.name}: buildInfo failed (${err.message})`);
      }

      if (!catalogTooLarge) {
        const dbList = await client
          .db("admin")
          .command({ listDatabases: 1, nameOnly: true });
        databases = (dbList?.databases || [])
          .map((d) => d?.name)
          .filter((name) => name && !isHiddenTopLevelDb(name))
          .sort();
      } else {
        console.warn(
          `[discovery] ${cluster.name}: catalogStats.collections=${cs.collections} > ${CATALOG_TOO_LARGE_THRESHOLD} — skipping listDatabases and per-collection scans`,
        );
      }
    } catch (err) {
      catalogError = err.message;
      console.warn(
        `[discovery] ${cluster.name}: catalog scan failed (${err.message})`,
      );
    }
  }

  const topology = {
    clusterId: cluster._id,
    clusterName: cluster.name,
    setName: hello?.setName || null,
    primary: canonicalPrimary,
    hosts: canonicalHosts,
    passives: hello?.passives || [],
    me: hello?.me || null,
    isWritablePrimary: hello?.isWritablePrimary || false,
    discoveredAt: new Date(),
    uriPrefix: uriPrefix || null,
    helloOk: !helloError,
    helloError: helloError ? helloError.message : null,
    catalogStats,
    catalogTooLarge,
    catalogError,
    catalogThreshold: CATALOG_TOO_LARGE_THRESHOLD,
    databases,
    serverVersion,
    serverVersionArray,
    queryStatsSupported,
    queryStatsMinVersion: `${QUERY_STATS_MIN_MAJOR}.${QUERY_STATS_MIN_MINOR}+`,
  };

  await getDb()
    .collection(TOPOLOGIES)
    .updateOne({ clusterId: cluster._id }, { $set: topology }, { upsert: true });

  const catalogSummary = catalogStats
    ? ` catalog=${catalogStats.collections} collections${catalogTooLarge ? " (TOO LARGE — skipping per-collection scans)" : ""}`
    : "";
  console.log(
    `Discovered ${cluster.name}: ${topology.hosts.length} members, primary=${topology.primary}${helloError ? " (SRV-only, hello auth failed)" : ""}${catalogSummary} dbs=${databases.length}`,
  );
  await logMonitorEvent({
    source: "discovery",
    action: "topology.discover",
    outcome: helloError ? "partial" : "ok",
    clusterId: cluster._id,
    clusterName: cluster.name,
    targetCollection: TOPOLOGIES,
    detail: helloError
      ? `SRV-only: ${topology.hosts.length} hosts (hello failed: ${helloError.message})`
      : `upsert topology: ${topology.hosts.length} hosts, primary=${topology.primary || "—"}, dbs=${databases.length}${catalogSummary}`,
    meta: {
      hostCount: topology.hosts.length,
      primary: topology.primary || null,
      helloOk: !helloError,
      catalogStats: catalogStats || undefined,
      catalogTooLarge: catalogTooLarge || undefined,
      databaseCount: databases.length,
    },
  });
  return topology;
}

async function discoverAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  if (!clusters.length) {
    console.log("No clusters registered — skipping discovery");
    return [];
  }

  console.log(`Discovering topology for ${clusters.length} cluster(s)…`);
  const results = [];

  for (const cluster of clusters) {
    if (!isClusterPollingEnabled(cluster)) {
      console.log(`[discovery] ${cluster.name}: skipped (isPolling=false)`);
      continue;
    }
    try {
      const topology = await discoverOne(cluster);
      results.push(topology);
    } catch (err) {
      console.error(`Discovery failed for "${cluster.name}":`, err.message);
      await logMonitorEvent({
        source: "discovery",
        action: "topology.discover",
        outcome: "error",
        clusterId: cluster._id,
        clusterName: cluster.name,
        targetCollection: TOPOLOGIES,
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = {
  discoverOne,
  discoverAll,
  // Exported for unit testing — keep stable.
  _internal: { supportsQueryStats, QUERY_STATS_MIN_MAJOR, QUERY_STATS_MIN_MINOR },
};
