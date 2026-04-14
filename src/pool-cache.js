const { MongoClient } = require("mongodb");
const { decrypt, isEncrypted } = require("./crypto");

const pools = new Map();

function decryptUri(uri) {
  return uri && isEncrypted(uri) ? decrypt(uri) : uri;
}

function getPool(cluster) {
  const id = cluster._id.toString();
  if (pools.has(id)) return pools.get(id);

  const uri = decryptUri(cluster.uri);
  if (!uri) throw new Error(`Cluster "${cluster.name}" has no URI`);

  const client = new MongoClient(uri, {
    maxPoolSize: 3,
    minPoolSize: 0,
    maxIdleTimeMS: 600_000,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
    appName: "MongoAdvisor",
  });

  pools.set(id, client);
  return client;
}

async function ensureConnected(cluster) {
  const client = getPool(cluster);
  await client.connect();
  return client;
}

function getDirectPool(cluster, host) {
  const key = `direct:${cluster._id}:${host}`;
  if (pools.has(key)) return pools.get(key);

  const uri = decryptUri(cluster.uri);
  if (!uri) throw new Error(`Cluster "${cluster.name}" has no URI`);

  const parsed = new URL(uri);
  const userInfo = parsed.username
    ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password || "")}@`
    : "";
  const params = parsed.search || "";
  const db = parsed.pathname || "/";
  const directUri = `mongodb://${userInfo}${host}${db}${params}`;

  const client = new MongoClient(directUri, {
    directConnection: true,
    tls: true,
    maxPoolSize: 2,
    minPoolSize: 0,
    maxIdleTimeMS: 600_000,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
    appName: "MongoAdvisor",
  });

  pools.set(key, client);
  return client;
}

async function ensureDirectConnected(cluster, host) {
  const client = getDirectPool(cluster, host);
  await client.connect();
  return client;
}

async function closeAll() {
  const closing = [];
  for (const [id, client] of pools) {
    closing.push(client.close().catch(() => {}));
  }
  await Promise.all(closing);
  pools.clear();
  console.log("All source cluster pools closed");
}

function removePool(clusterId) {
  removePoolsForCluster(clusterId);
}

/** Close SRV and all per-host direct pools for one cluster (e.g. after URI change). */
function removePoolsForCluster(clusterId) {
  const id = clusterId.toString();
  const keys = [];
  for (const k of pools.keys()) {
    if (k === id || (typeof k === "string" && k.startsWith(`direct:${id}:`))) keys.push(k);
  }
  for (const k of keys) {
    const client = pools.get(k);
    if (client) client.close().catch(() => {});
    pools.delete(k);
  }
}

module.exports = {
  getPool,
  ensureConnected,
  ensureDirectConnected,
  closeAll,
  removePool,
  removePoolsForCluster,
};
