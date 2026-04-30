const dns = require("dns").promises;
const { getDb } = require("./db");
const { ensureConnected } = require("./pool-cache");
const { decrypt, isEncrypted } = require("./crypto");
const { logMonitorEvent } = require("./monitor-log");
const { isClusterPollingEnabled } = require("./cluster-polling");

const TOPOLOGIES = "topologies";
const CLUSTERS = "clusters";

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
 * e.g. "mongomonitor-shard-00-01.ljwx2.mongodb.net:27017" → "shard-00-01"
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
  };

  await getDb()
    .collection(TOPOLOGIES)
    .updateOne({ clusterId: cluster._id }, { $set: topology }, { upsert: true });

  console.log(
    `Discovered ${cluster.name}: ${topology.hosts.length} members, primary=${topology.primary}${helloError ? " (SRV-only, hello auth failed)" : ""}`,
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
      : `upsert topology: ${topology.hosts.length} hosts, primary=${topology.primary || "—"}`,
    meta: { hostCount: topology.hosts.length, primary: topology.primary || null, helloOk: !helloError },
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

module.exports = { discoverOne, discoverAll };
