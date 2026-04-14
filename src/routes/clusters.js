const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { encrypt, decrypt, isEncrypted } = require("../crypto");
const { logMonitorEvent } = require("../monitor-log");
const { createAtlasDatabaseUser, atlasErrorMessage } = require("../atlas-db-users");
const { removePoolsForCluster } = require("../pool-cache");

const router = Router();
const COLLECTION = "clusters";

const ENCRYPTED_FIELDS = ["uri", "atlasPrivateKey"];

function decryptField(value) {
  return value && isEncrypted(value) ? decrypt(value) : value;
}

function maskUri(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = "••••••";
    return u.toString();
  } catch {
    return "••••••";
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return "••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

function sanitizeCluster(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  if (out.uri) {
    const plain = decryptField(out.uri);
    out.uri = maskUri(plain);
  }
  if (out.atlasPrivateKey) {
    const plain = decryptField(out.atlasPrivateKey);
    out.atlasPrivateKey = maskKey(plain);
  }
  return out;
}

function encryptField(value) {
  return value ? encrypt(value) : value;
}

router.get("/", async (_req, res, next) => {
  try {
    const clusters = await getDb().collection(COLLECTION).find().toArray();
    res.json(clusters.map(sanitizeCluster));
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
    res.json(sanitizeCluster(cluster));
  } catch (err) {
    next(err);
  }
});

/**
 * Partial update (name, region, uri, Atlas fields). Omitted keys are unchanged.
 * Empty `atlasPrivateKey` clears the stored private key. Connection pools reload when `uri` changes.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const prev = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!prev) return res.status(404).json({ error: "Cluster not found" });

    const body = req.body || {};
    const $set = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const n = String(body.name || "").trim();
      if (!n) return res.status(400).json({ error: "name cannot be empty" });
      $set.name = n;
    }
    if (Object.prototype.hasOwnProperty.call(body, "region")) {
      $set.region =
        body.region != null && String(body.region).trim() ? String(body.region).trim() : "unknown";
    }
    if (Object.prototype.hasOwnProperty.call(body, "uri")) {
      const u = String(body.uri || "").trim();
      if (!u) return res.status(400).json({ error: "uri cannot be empty when provided" });
      $set.uri = encryptField(u);
    }
    if (Object.prototype.hasOwnProperty.call(body, "atlasProjectId")) {
      $set.atlasProjectId = body.atlasProjectId ? String(body.atlasProjectId).trim() : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "atlasPublicKey")) {
      $set.atlasPublicKey = body.atlasPublicKey ? String(body.atlasPublicKey).trim() : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "atlasPrivateKey")) {
      const k = String(body.atlasPrivateKey ?? "").trim();
      $set.atlasPrivateKey = k ? encryptField(k) : null;
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    await getDb().collection(COLLECTION).updateOne({ _id: oid }, { $set });
    if (Object.prototype.hasOwnProperty.call($set, "uri")) {
      removePoolsForCluster(oid);
    }

    const updated = await getDb().collection(COLLECTION).findOne({ _id: oid });
    await logMonitorEvent({
      source: "api",
      action: "cluster.update",
      outcome: "ok",
      clusterId: oid,
      clusterName: updated.name,
      targetCollection: COLLECTION,
      detail: `updated: ${Object.keys($set).join(", ")}`,
    });
    res.json(sanitizeCluster(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Create an Atlas database user using this cluster’s stored Atlas API credentials.
 * Defaults: preset `metrics`, scoped to the cluster’s registered name in Atlas.
 */
router.post("/:id/atlas-database-users", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const cluster = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });
    if (!cluster.atlasProjectId || !cluster.atlasPublicKey || !cluster.atlasPrivateKey) {
      return res.status(400).json({
        error:
          "Cluster must have Atlas Project ID, Public API Key, and Private API Key (add when registering or re-register the cluster).",
      });
    }

    const { username, password, preset = "metrics", scopeToCluster = true } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (preset !== "metrics" && preset !== "backend") {
      return res.status(400).json({ error: 'preset must be "metrics" or "backend"' });
    }

    const privateKey = decryptField(cluster.atlasPrivateKey);
    const clusterName = scopeToCluster === false ? undefined : cluster.name;

    const result = await createAtlasDatabaseUser({
      projectId: cluster.atlasProjectId,
      publicKey: cluster.atlasPublicKey,
      privateKey,
      preset,
      username: String(username).trim(),
      password: String(password),
      clusterName,
    });

    if (!result.ok) {
      const httpStatus = result.clientError
        ? 400
        : result.status >= 400 && result.status < 600
          ? result.status
          : 502;
      const msg = atlasErrorMessage(result);
      await logMonitorEvent({
        source: "api",
        action: "atlas.databaseUser.create",
        outcome: "error",
        clusterId: cluster._id,
        clusterName: cluster.name,
        detail: `cluster-scoped preset=${preset} user=${username}`,
        error: msg,
        meta: { status: result.status },
      });
      return res.status(httpStatus).json({
        ok: false,
        error: msg,
        atlas: result.json || undefined,
      });
    }

    await logMonitorEvent({
      source: "api",
      action: "atlas.databaseUser.create",
      outcome: "ok",
      clusterId: cluster._id,
      clusterName: cluster.name,
      detail: `cluster-scoped preset=${preset} user=${username}`,
      meta: { roles: result.json?.roles, scopes: result.json?.scopes },
    });

    return res.status(201).json({
      ok: true,
      username: result.json?.username,
      roles: result.json?.roles,
      scopes: result.json?.scopes,
    });
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
    const created = { _id: result.insertedId, ...doc };
    await logMonitorEvent({
      source: "api",
      action: "cluster.create",
      outcome: "ok",
      clusterId: result.insertedId,
      clusterName: name,
      targetCollection: COLLECTION,
      detail: `registered cluster "${name}"`,
    });
    res.status(201).json(sanitizeCluster(created));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const prev = await getDb().collection(COLLECTION).findOne({ _id: oid }, { projection: { name: 1 } });
    const result = await getDb().collection(COLLECTION).deleteOne({ _id: oid });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Cluster not found" });
    removePoolsForCluster(oid);
    await logMonitorEvent({
      source: "api",
      action: "cluster.delete",
      outcome: "ok",
      clusterId: oid,
      clusterName: prev?.name || "unknown",
      targetCollection: COLLECTION,
      detail: "cluster registration removed",
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
