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
    appName: "MongoMonitor",
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
  const key = `direct:${host}`;
  if (pools.has(key)) return pools.get(key);

  const uri = decryptUri(cluster.uri);
  if (!uri) throw new Error(`Cluster "${cluster.name}" has no URI`);

  const parsed = new URL(uri);
  const userInfo = parsed.username ? `${parsed.username}:${parsed.password}@` : "";
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
    appName: "MongoMonitor",
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
  const id = clusterId.toString();
  const client = pools.get(id);
  if (client) {
    client.close().catch(() => {});
    pools.delete(id);
  }
}

module.exports = { getPool, ensureConnected, ensureDirectConnected, closeAll, removePool };
