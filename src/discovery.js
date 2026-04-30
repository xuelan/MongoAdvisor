const { getDb } = require("./db");
const { ensureConnected } = require("./pool-cache");
const { logMonitorEvent } = require("./monitor-log");
const { isClusterPollingEnabled } = require("./cluster-polling");

const TOPOLOGIES = "topologies";
const CLUSTERS = "clusters";

async function discoverOne(cluster) {
  const client = await ensureConnected(cluster);
  const hello = await client.db("admin").command({ hello: 1 });

  const topology = {
    clusterId: cluster._id,
    clusterName: cluster.name,
    setName: hello.setName || null,
    primary: hello.primary || null,
    hosts: hello.hosts || [],
    passives: hello.passives || [],
    me: hello.me || null,
    isWritablePrimary: hello.isWritablePrimary || false,
    discoveredAt: new Date(),
  };

  await getDb()
    .collection(TOPOLOGIES)
    .updateOne({ clusterId: cluster._id }, { $set: topology }, { upsert: true });

  console.log(
    `Discovered ${cluster.name}: ${topology.hosts.length} members, primary=${topology.primary}`,
  );
  await logMonitorEvent({
    source: "discovery",
    action: "topology.discover",
    outcome: "ok",
    clusterId: cluster._id,
    clusterName: cluster.name,
    targetCollection: TOPOLOGIES,
    detail: `upsert topology: ${topology.hosts.length} hosts, primary=${topology.primary || "—"}`,
    meta: { hostCount: topology.hosts.length, primary: topology.primary || null },
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
