const { MongoClient } = require("mongodb");

let client;

async function connect() {
  if (client) return client;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI environment variable is not set");

  client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 300_000,
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
  });

  await client.connect();
  console.log("Connected to MongoDB backend");
  return client;
}

function getDb() {
  if (!client) throw new Error("Database not connected. Call connect() first.");
  return client.db(process.env.MONGO_DB || "mongomonitor");
}

function getClient() {
  return client;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    console.log("MongoDB connection closed");
  }
}

module.exports = { connect, getDb, getClient, close };
