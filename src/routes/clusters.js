const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { EJSON } = require("bson");
const { getDb } = require("../db");
const { encrypt, decrypt, isEncrypted } = require("../crypto");
const { logMonitorEvent } = require("../monitor-log");
const { createAtlasDatabaseUser, atlasErrorMessage } = require("../atlas-db-users");
const { removePoolsForCluster, ensureConnected } = require("../pool-cache");

const router = Router();
const COLLECTION = "clusters";

const ENCRYPTED_FIELDS = ["uri", "atlasPrivateKey"];

const VALID_ENVIRONMENTS = new Set(["production", "staging", "dev"]);

/** Production clusters require an explicit confirmation before explain() runs against them. */
function isProtectedCluster(cluster) {
  return cluster && cluster.environment === "production";
}

function normalizeEnvironment(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  return VALID_ENVIRONMENTS.has(v) ? v : undefined;
}

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
  // Surface a defaulted environment so the UI doesn't have to guess about pre-existing rows.
  out.environment = out.environment || "dev";
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
 * Partial update (name, uri, Atlas fields, isPolling). Omitted keys are unchanged.
 * Empty `atlasPrivateKey` clears the stored private key. Connection pools reload when `uri` changes.
 * `isPolling: false` pauses scheduled collection for that cluster (no server restart).
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const prev = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!prev) return res.status(404).json({ error: "Cluster not found" });

    const body = req.body || {};
    const $set = {};
    const prevPollingEffective = prev.isPolling !== false;

    if (Object.prototype.hasOwnProperty.call(body, "isPolling")) {
      if (typeof body.isPolling !== "boolean") {
        return res.status(400).json({ error: "isPolling must be a boolean" });
      }
      $set.isPolling = body.isPolling;
    }

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const n = String(body.name || "").trim();
      if (!n) return res.status(400).json({ error: "name cannot be empty" });
      $set.name = n;
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
    if (Object.prototype.hasOwnProperty.call(body, "environment")) {
      const env = normalizeEnvironment(body.environment);
      if (env === undefined) {
        return res.status(400).json({
          error: `environment must be one of: ${[...VALID_ENVIRONMENTS].join(", ")}`,
        });
      }
      $set.environment = env || "dev";
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    await getDb().collection(COLLECTION).updateOne({ _id: oid }, { $set });
    if (Object.prototype.hasOwnProperty.call($set, "uri")) {
      removePoolsForCluster(oid);
      // Re-discover immediately so topology reflects the new URI (SRV hostnames, primary)
      const { discoverOne } = require("../discovery");
      const freshCluster = await getDb().collection(COLLECTION).findOne({ _id: oid });
      discoverOne(freshCluster).catch((err) =>
        console.error(`[discovery] post-URI-update rediscover for "${freshCluster?.name}" failed:`, err.message),
      );
    }

    const updated = await getDb().collection(COLLECTION).findOne({ _id: oid });
    const newPollingEffective = updated.isPolling !== false;
    const pollingToggled =
      Object.prototype.hasOwnProperty.call(body, "isPolling") &&
      prevPollingEffective !== newPollingEffective;

    if (pollingToggled) {
      await logMonitorEvent({
        source: "api",
        action: "cluster.polling",
        outcome: "ok",
        clusterId: oid,
        clusterName: updated.name,
        targetCollection: COLLECTION,
        detail: newPollingEffective ? "collection polling enabled" : "collection polling paused",
        meta: { isPolling: newPollingEffective },
      });
    }

    const isPollingOnlyPatch =
      Object.keys($set).length === 1 && Object.prototype.hasOwnProperty.call($set, "isPolling");
    if (!isPollingOnlyPatch) {
      await logMonitorEvent({
        source: "api",
        action: "cluster.update",
        outcome: "ok",
        clusterId: oid,
        clusterName: updated.name,
        targetCollection: COLLECTION,
        detail: `updated: ${Object.keys($set).join(", ")}`,
      });
    }
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
    const { name, uri, provider, atlasProjectId, atlasPublicKey, atlasPrivateKey, environment } = req.body;
    if (!name || !uri) {
      return res.status(400).json({ error: "name and uri are required" });
    }
    const env = normalizeEnvironment(environment);
    if (env === undefined) {
      return res.status(400).json({
        error: `environment must be one of: ${[...VALID_ENVIRONMENTS].join(", ")}`,
      });
    }
    const doc = {
      name,
      uri: encryptField(uri),
      provider: provider || "unknown",
      atlasProjectId: atlasProjectId || null,
      atlasPublicKey: atlasPublicKey || null,
      atlasPrivateKey: encryptField(atlasPrivateKey),
      environment: env || "dev",
      isPolling: true,
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

    // Kick off topology discovery so the new cluster's members appear in the UI immediately.
    // SRV-resolved hostnames are written even if the live `hello` fails, so a typo in the URI
    // still yields a topology row with `helloOk: false` and the red badge in the UI.
    const { discoverOne } = require("../discovery");
    const collector = require("../collector");
    discoverOne(created)
      .then(() => {
        // After discovery succeeds, run a one-shot collection pass for this cluster so
        // queryStats / databases / storage panels populate without waiting for the next tick.
        if (typeof collector.collectQueryStats === "function") {
          collector.collectQueryStats(created).catch((err) =>
            console.error(`[queryStats] post-create for "${name}" failed:`, err.message),
          );
        }
        if (typeof collector.collectStorageStatsForCluster === "function") {
          collector.collectStorageStatsForCluster(created).catch((err) =>
            console.error(`[storageStats] post-create for "${name}" failed:`, err.message),
          );
        }
      })
      .catch((err) =>
        console.error(`[discovery] post-create discover for "${name}" failed:`, err.message),
      );

    res.status(201).json(sanitizeCluster(created));
  } catch (err) {
    next(err);
  }
});

// ─── Explain (read-only) ────────────────────────────────────────────
//
// POST /api/clusters/:id/explain
// Body: { namespace: "db.coll", command: <object from slow_queries.command> }
//
// The slow-query body captured from Atlas log lines is *Extended JSON*: date values arrive as
// `{ "$date": "2020-12-31T23:59:59.000Z" }`, ObjectIds as `{ "$oid": "…" }`, etc. The MongoDB
// wire protocol cannot accept those shapes literally — it expects native BSON types — so we
// round-trip the whole command through `EJSON.deserialize` before handing it to the driver.
// Mongosh's `ISODate("…")` is simply the display form of the same BSON `Date` instance.

const ALLOWED_EXPLAIN_OPS = new Set(["find", "aggregate", "count", "distinct"]);
const ALLOWED_EXPLAIN_VERBOSITY = new Set(["queryPlanner", "executionStats", "allPlansExecution"]);

// Fields that are safe and meaningful to keep in the command we pass to explain.
// Anything else (session / routing / auth / cluster-time metadata) would either be
// rejected by the server or leak caller-specific context when re-run elsewhere.
const META_FIELDS = new Set([
  "$db",
  "$clusterTime",
  "$audit",
  "lsid",
  "txnNumber",
  "autocommit",
  "startTransaction",
  "stmtId",
  "apiVersion",
  "apiStrict",
  "apiDeprecationErrors",
  "mayBypassWriteBlocking",
  "signature",
  // Re-added by us as a fresh, explicit value.
  "maxTimeMS",
  // Drop the original caller's comment so this explain run doesn't alias their traffic.
  "comment",
  // Write concerns have no effect on read commands but can still trip strict servers.
  "writeConcern",
]);

function stripMetaFields(cmd) {
  const out = {};
  for (const [k, v] of Object.entries(cmd)) {
    if (META_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function hasForbiddenPipelineStage(pipeline) {
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some((stage) => {
    if (!stage || typeof stage !== "object") return false;
    return Object.prototype.hasOwnProperty.call(stage, "$out") || Object.prototype.hasOwnProperty.call(stage, "$merge");
  });
}

router.post("/:id/explain", async (req, res, next) => {
  let cluster = null;
  try {
    const oid = new ObjectId(req.params.id);
    cluster = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    const body = req.body || {};
    const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
    const rawCommand = body.command;
    const verbosity = ALLOWED_EXPLAIN_VERBOSITY.has(body.verbosity) ? body.verbosity : "executionStats";

    // Production guardrail: require explicit double-confirmation (checkbox + typed cluster name).
    // The UI surfaces a red banner so this never fires from a normal flow without intent.
    const protectedCluster = isProtectedCluster(cluster);
    if (protectedCluster) {
      const confirmed = body.confirmProduction === true;
      const namedMatches = typeof body.confirmClusterName === "string"
        && body.confirmClusterName === cluster.name;
      if (!confirmed || !namedMatches) {
        await logMonitorEvent({
          source: "api",
          action: "explain.run",
          outcome: "blocked",
          clusterId: cluster._id,
          clusterName: cluster.name,
          targetCollection: "slow_queries",
          detail: "production explain blocked: missing confirmation",
          meta: { environment: cluster.environment, namespace, verbosity },
        }).catch(() => {});
        return res.status(403).json({
          error: "Explain on a production cluster requires explicit confirmation",
          code: "PRODUCTION_CONFIRM_REQUIRED",
          clusterName: cluster.name,
          environment: cluster.environment,
        });
      }
    }

    // Cap the user-requested timeout to something sane: 5s lower bound (so we always give
    // the server room to parse+plan) and 10 minutes upper bound (to prevent runaway explains
    // from holding an HTTP worker forever). Production clusters get a tighter 60s cap so a
    // misclick cannot park a long-running explain on prod.
    const requestedTimeoutMs = Number(body.timeoutMs);
    const HARD_MAX_TIMEOUT_MS = protectedCluster ? 60_000 : 600_000;
    const EXPLAIN_TIMEOUT_MS = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(Math.max(requestedTimeoutMs, 5_000), HARD_MAX_TIMEOUT_MS)
      : Math.min(120_000, HARD_MAX_TIMEOUT_MS);

    if (!namespace || !namespace.includes(".")) {
      return res.status(400).json({ error: "namespace (db.collection) is required" });
    }
    if (!rawCommand || typeof rawCommand !== "object" || Array.isArray(rawCommand)) {
      return res.status(400).json({ error: "command object is required" });
    }

    const dbName = namespace.slice(0, namespace.indexOf("."));

    // EJSON.deserialize converts `{ $date: "…" }`, `{ $oid: "…" }`, `{ $numberLong: "…" }`
    // and all other canonical EJSON shapes into native BSON types that the driver/server
    // understand. Without this step, `$match: { "reviews.date": { $gte: { $date: "…" } } }`
    // is sent as a literal subdocument with a `$date` field and matches nothing.
    let deserialized;
    try {
      deserialized = EJSON.deserialize(rawCommand, { relaxed: false });
    } catch (e) {
      return res.status(400).json({ error: `Failed to deserialize command: ${e.message}` });
    }

    const cleaned = stripMetaFields(deserialized);
    const op = Object.keys(cleaned).find((k) => !k.startsWith("$"));
    if (!op || !ALLOWED_EXPLAIN_OPS.has(op)) {
      return res
        .status(400)
        .json({ error: `Only read-only commands are allowed for explain (${[...ALLOWED_EXPLAIN_OPS].join(", ")})` });
    }
    if (op === "aggregate" && hasForbiddenPipelineStage(cleaned.pipeline)) {
      return res.status(400).json({ error: "Aggregation contains $out or $merge (write stage); refusing to run explain" });
    }

    // aggregate needs a cursor spec to be a valid command.
    if (op === "aggregate" && cleaned.cursor == null) {
      cleaned.cursor = {};
    }

    const started = Date.now();

    const client = await ensureConnected(cluster);
    const db = client.db(dbName);

    const result = await db.command(
      { explain: cleaned, verbosity, maxTimeMS: EXPLAIN_TIMEOUT_MS },
      { maxTimeMS: EXPLAIN_TIMEOUT_MS },
    );

    const elapsedMs = Date.now() - started;

    await logMonitorEvent({
      source: "api",
      action: "explain.run",
      outcome: "ok",
      clusterId: cluster._id,
      clusterName: cluster.name,
      targetCollection: "slow_queries",
      detail: `explain(${verbosity}) on ${namespace} — ${op}`,
      meta: {
        namespace,
        op,
        verbosity,
        elapsedMs,
        timeoutMs: EXPLAIN_TIMEOUT_MS,
        environment: cluster.environment || "dev",
        confirmedBy: protectedCluster ? "ui" : undefined,
      },
    });

    // Serialize with EJSON so BSON types (Long, Date, ObjectId) survive JSON transport.
    res.json({
      ok: true,
      namespace,
      op,
      verbosity,
      elapsedMs,
      result: EJSON.serialize(result, { relaxed: true }),
    });
  } catch (err) {
    await logMonitorEvent({
      source: "api",
      action: "explain.run",
      outcome: "error",
      clusterId: cluster?._id,
      clusterName: cluster?.name,
      error: err.message,
      meta: { environment: cluster?.environment || "dev" },
    }).catch(() => {});
    // Surface the driver's error message so the UI can show why explain failed
    // (invalid command shape, auth, missing index on explained field, etc.).
    res.status(400).json({ error: err.message || "Explain failed" });
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
