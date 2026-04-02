const { MongoClient, ObjectId } = require("mongodb");
const { getDb } = require("./db");
const { decrypt, isEncrypted } = require("./crypto");

const TOPOLOGIES = "topologies";
const CLUSTERS = "clusters";

function decryptUri(encryptedUri) {
  return encryptedUri && isEncrypted(encryptedUri) ? decrypt(encryptedUri) : encryptedUri;
}

async function discoverOne(cluster) {
  const uri = decryptUri(cluster.uri);
  if (!uri) throw new Error(`Cluster "${cluster.name}" has no URI`);

  const sourceClient = new MongoClient(uri, {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 1,
  });

  try {
    await sourceClient.connect();
    const hello = await sourceClient.db("admin").command({ hello: 1 });

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
      .updateOne(
        { clusterId: cluster._id },
        { $set: topology },
        { upsert: true },
      );

    console.log(
      `Discovered ${cluster.name}: ${topology.hosts.length} members, primary=${topology.primary}`,
    );
    return topology;
  } finally {
    await sourceClient.close();
  }
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
    try {
      const topology = await discoverOne(cluster);
      results.push(topology);
    } catch (err) {
      console.error(`Discovery failed for "${cluster.name}":`, err.message);
    }
  }

  return results;
}

module.exports = { discoverOne, discoverAll };
