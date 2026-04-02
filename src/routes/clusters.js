const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { encrypt, decrypt, isEncrypted } = require("../crypto");

const router = Router();
const COLLECTION = "clusters";

const ENCRYPTED_FIELDS = ["uri", "atlasPrivateKey"];

function decryptField(value) {
  return value && isEncrypted(value) ? decrypt(value) : value;
}

function decryptCluster(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  for (const field of ENCRYPTED_FIELDS) {
    if (out[field]) out[field] = decryptField(out[field]);
  }
  return out;
}

function encryptField(value) {
  return value ? encrypt(value) : value;
}

router.get("/", async (_req, res, next) => {
  try {
    const clusters = await getDb().collection(COLLECTION).find().toArray();
    res.json(clusters.map(decryptCluster));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const cluster = await getDb()
      .collection(COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });
    res.json(decryptCluster(cluster));
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, uri, provider, region, atlasProjectId, atlasPublicKey, atlasPrivateKey } = req.body;
    if (!name || !uri) {
      return res.status(400).json({ error: "name and uri are required" });
    }
    const doc = {
      name,
      uri: encryptField(uri),
      provider: provider || "unknown",
      region: region || "unknown",
      atlasProjectId: atlasProjectId || null,
      atlasPublicKey: atlasPublicKey || null,
      atlasPrivateKey: encryptField(atlasPrivateKey),
      createdAt: new Date(),
    };
    const result = await getDb().collection(COLLECTION).insertOne(doc);
    res.status(201).json(decryptCluster({ _id: result.insertedId, ...doc }));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await getDb()
      .collection(COLLECTION)
      .deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Cluster not found" });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
