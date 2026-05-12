/**
 * Parser for getMongoData.js JSON output.
 *
 * Input: text from a single capture (one `mongo getMongoData.js > getMongoData.log`).
 * Output: a normalized object the health checks can read without re-walking the array.
 *
 * The wire format is an array of `{ section, subsection, output, host, ts, version, ... }`
 * documents in the order the script emits them — see
 * https://github.com/mongodb/support-tools/tree/master/getMongoData. All section bodies are
 * optional: if the capture was truncated or the script aborted mid-run, missing sections are
 * left `null` / `[]` and the report still renders the slices we did get.
 */

/**
 * Parse a raw getMongoData JSON string into the array of section docs.
 *
 * The file is EJSON-flavored JSON (`{"$date": …}`, `{"$numberLong": …}`, `{"$timestamp": …}`)
 * but some getMongoData captures use non-standard shapes (e.g. `"$timestamp": "<digits>"`
 * instead of the spec'd `{ "t": …, "i": … }`). We avoid `EJSON.parse` because it rejects
 * those, and instead do a plain `JSON.parse` + in-house unwrap of the EJSON wrappers we
 * actually care about.
 */
function parse(text) {
  if (typeof text !== "string") {
    throw new Error("parse() expects a string of EJSON text");
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("getMongoData output must be a JSON array at the root");
  }
  return unwrapEjson(parsed);
}

/**
 * Walk the structure and replace common EJSON wrappers with plain JS values:
 *   `{ $numberLong: "N" }`   → Number(N)   (loses precision for very large ints; OK for stats)
 *   `{ $numberInt:  "N" }`   → Number(N)
 *   `{ $numberDouble: "N" }` → Number(N)
 *   `{ $date: ms }`          → ms (number, ISO 8601 string)
 *   `{ $date: { $numberLong: "ms" } }` → Number(ms)
 *   `{ $timestamp: "<digits or {t,i}>" }` → leaves the raw string/object intact at `$timestamp`
 *   `{ $oid: "…" }`          → "…"
 */
function unwrapEjson(node) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = unwrapEjson(node[i]);
    return node;
  }
  const keys = Object.keys(node);
  if (keys.length === 1) {
    const k = keys[0];
    const v = node[k];
    if (k === "$numberLong" || k === "$numberInt" || k === "$numberDouble") {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    if (k === "$date") {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : v;
      }
      if (v && typeof v === "object" && "$numberLong" in v) {
        return Number(v.$numberLong);
      }
      return v;
    }
    if (k === "$oid") return typeof v === "string" ? v : v;
    if (k === "$timestamp") return v;
  }
  for (const k of keys) node[k] = unwrapEjson(node[k]);
  return node;
}

/** Strip the `_(mb)` / `_for_database_'…'` suffix from a subsection name. */
function baseSubsection(s) {
  if (!s) return "";
  return String(s).replace(/_\(mb\)$/, "");
}

function findFirst(sections, sectionName, subsectionName) {
  for (const doc of sections) {
    if (doc?.section === sectionName && doc?.subsection === subsectionName) {
      return doc;
    }
  }
  return null;
}

function findAll(sections, sectionName, subsectionName) {
  const out = [];
  for (const doc of sections) {
    if (doc?.section === sectionName && doc?.subsection === subsectionName) {
      out.push(doc);
    }
  }
  return out;
}

/** db name out of `"list_of_collections_for_database_'foo'"` → `"foo"`. */
function dbNameFromSubsection(subsection, prefix) {
  const m = String(subsection || "").match(
    new RegExp("^" + prefix + "'(.+)'$"),
  );
  return m ? m[1] : null;
}

/**
 * Walk the data_info entries (which are emitted in DB → collection → indexes → indexStats
 * order by getMongoData.js) and group them into `{ databases: [{ name, stats, profiler,
 * collections: [{ name, stats, indexes, indexStats }] }] }`.
 */
function buildDataInfo(sections) {
  const dataDocs = sections.filter((d) => d?.section === "data_info");
  const dbs = new Map();
  let currentDb = null;
  let currentColl = null;

  /**
   * Keyed lookup is case-insensitive because getMongoData.js lowercases section names
   * (e.g. `list_of_collections_for_database_'replicaDB'` becomes `'replicadb'` in the
   * subsection field), while `collStats.output.ns` preserves the real case. We want both
   * pointers to land on the same record.
   */
  function ensureDb(name) {
    const key = String(name).toLowerCase();
    if (!dbs.has(key)) {
      dbs.set(key, { name, stats: null, profiler: null, collections: [], collectionsList: [] });
    } else if (
      // Upgrade the stored name when a case-preserving source (collStats.ns) provides it.
      name !== name.toLowerCase() &&
      dbs.get(key).name === dbs.get(key).name.toLowerCase()
    ) {
      dbs.get(key).name = name;
    }
    return dbs.get(key);
  }

  function ensureColl(db, name) {
    let coll = db.collections.find((c) => c.name === name);
    if (!coll) {
      coll = { name, stats: null, indexes: [], indexStats: null };
      db.collections.push(coll);
    }
    return coll;
  }

  for (const doc of dataDocs) {
    const sub = doc.subsection || "";
    const out = doc.output;

    if (sub === "list_of_databases") continue; // metadata only

    let dbName = dbNameFromSubsection(sub, "list_of_collections_for_database_");
    if (dbName) {
      currentDb = ensureDb(dbName);
      currentColl = null;
      currentDb.collectionsList = Array.isArray(out) ? out : [];
      continue;
    }

    dbName = dbNameFromSubsection(sub, "database_stats_for_database_");
    if (dbName) {
      currentDb = ensureDb(dbName);
      currentColl = null;
      currentDb.stats = out;
      continue;
    }

    // Pre-4.x getMongoData emits "database_stats_(mb)" with no db name in the subsection
    // and instead relies on the running cursor. Use `output.db` (mongo's standard dbStats
    // response) when present.
    if (baseSubsection(sub) === "database_stats") {
      if (out && typeof out === "object" && typeof out.db === "string") {
        currentDb = ensureDb(out.db);
      }
      if (currentDb) currentDb.stats = out;
      currentColl = null;
      continue;
    }

    dbName = dbNameFromSubsection(sub, "database_profiler_for_database_");
    if (dbName) {
      const db = ensureDb(dbName);
      db.profiler = out;
      continue;
    }
    // commandParameters: { db } variant
    if (sub === "database_profiler" && doc.commandParameters?.db) {
      const db = ensureDb(doc.commandParameters.db);
      db.profiler = out;
      continue;
    }

    if (baseSubsection(sub) === "collection_stats") {
      // The collection name is in `output.ns` like "config.image_collection".
      const ns = out?.ns || (out?.shards && Object.values(out.shards)[0]?.ns);
      if (typeof ns === "string") {
        const dot = ns.indexOf(".");
        const dbn = dot === -1 ? "" : ns.slice(0, dot);
        const cn = dot === -1 ? ns : ns.slice(dot + 1);
        const db = ensureDb(dbn);
        currentDb = db;
        currentColl = ensureColl(db, cn);
        currentColl.stats = out;
      }
      continue;
    }

    if (sub === "indexes") {
      // commandParameters: { db, collection }
      const dbn = doc.commandParameters?.db;
      const cn = doc.commandParameters?.collection;
      if (dbn && cn) {
        const db = ensureDb(dbn);
        currentDb = db;
        currentColl = ensureColl(db, cn);
        currentColl.indexes = Array.isArray(out) ? out : [];
      } else if (currentColl) {
        currentColl.indexes = Array.isArray(out) ? out : [];
      }
      continue;
    }

    if (sub === "index_stats") {
      // The aggregate response sits in `output.cursor.firstBatch`.
      const batch = out?.cursor?.firstBatch || [];
      if (currentColl) {
        currentColl.indexStats = batch;
      }
      continue;
    }

    // Unknown subsection — leave it; raw is still preserved at the report level.
  }

  return Array.from(dbs.values());
}

function detectTopology(sections) {
  const ismaster = findFirst(sections, "shard_or_replicaset_info", "ismaster")?.output;
  if (ismaster?.msg === "isdbgrid") return "mongos";
  if (ismaster?.setName) return "replicaSet";
  if (ismaster?.ismaster || ismaster?.isWritablePrimary) return "standalone";
  if (findFirst(sections, "replicaset_info", "replica_set_config")) return "replicaSet";
  if (findFirst(sections, "shard_info", "shards")) return "sharded";
  return "unknown";
}

function pickServerInfo(sections) {
  return {
    serverStatus: findFirst(sections, "server_info", "server_status_info")?.output || null,
    hostInfo: findFirst(sections, "server_info", "host_info")?.output || null,
    cmdLine: findFirst(sections, "server_info", "command_line_info")?.output || null,
    buildInfo: findFirst(sections, "server_info", "server_build_info")?.output || null,
    parameters: findFirst(sections, "server_info", "server_parameters")?.output || null,
    shellVersion: findFirst(sections, "server_info", "shell_version")?.output || null,
    shellHostname: findFirst(sections, "server_info", "shell_hostname")?.output || null,
  };
}

function pickReplicaSet(sections) {
  const conf = findFirst(sections, "replicaset_info", "replica_set_config")?.output || null;
  const status = findFirst(sections, "replicaset_info", "replica_status")?.output || null;
  const info = findFirst(sections, "replicaset_info", "replica_info")?.output || null;
  if (!conf && !status && !info) return null;
  return { conf, status, info };
}

function pickShardInfo(sections) {
  const docs = sections.filter((d) => d?.section === "shard_info");
  if (docs.length === 0) return null;
  const out = {};
  for (const d of docs) {
    out[d.subsection] = d.output;
  }
  return out;
}

function pickIsMaster(sections) {
  return findFirst(sections, "shard_or_replicaset_info", "ismaster")?.output || null;
}

function pickUserAuth(sections) {
  return {
    databaseUserCount: findFirst(sections, "user_auth_info", "database_user_count")?.output ?? null,
    customRoleCount: findFirst(sections, "user_auth_info", "custom_role_count")?.output ?? null,
  };
}

function pickDrivers(sections) {
  const d = findFirst(sections, "driverVersions", "driver_versions");
  return d ? d.output : null;
}

/** What host did getMongoData actually connect to? We prefer the explicit `serverStatus.host`. */
function pickReportedHost(sections, serverStatus) {
  if (serverStatus?.host) return serverStatus.host;
  // Fall back to the first entry's `host` (the shell hostname — not the mongod host).
  return sections.find((d) => d?.host)?.host || null;
}

/**
 * Normalize a freshly parsed `sections` array into the shape our checks consume.
 */
function normalize(sections) {
  if (!Array.isArray(sections)) {
    throw new Error("normalize() expects an array of section docs");
  }
  const server = pickServerInfo(sections);
  const ismaster = pickIsMaster(sections);
  const replicaSet = pickReplicaSet(sections);
  const shardInfo = pickShardInfo(sections);
  const userAuth = pickUserAuth(sections);
  const drivers = pickDrivers(sections);
  const databases = buildDataInfo(sections);

  return {
    topology: detectTopology(sections),
    reportedHost: pickReportedHost(sections, server.serverStatus),
    setName:
      replicaSet?.conf?._id ||
      replicaSet?.status?.set ||
      ismaster?.setName ||
      null,
    getMongoDataVersion: sections.find((d) => d?.version)?.version || null,
    capturedAt:
      sections.find((d) => d?.ts?.start)?.ts?.start ||
      sections.find((d) => d?.ts?.start?.$date)?.ts?.start?.$date ||
      null,
    server,
    ismaster,
    replicaSet,
    shardInfo,
    userAuth,
    drivers,
    databases,
  };
}

module.exports = { parse, normalize };
