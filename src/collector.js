const crypto = require("crypto");
const { getDb } = require("./db");
const { ensureConnected, ensureDirectConnected } = require("./pool-cache");
const { decrypt, isEncrypted } = require("./crypto");
const { discoverAll } = require("./discovery");

const CLUSTERS = "clusters";
const QUERY_STATS = "query_stats";
const SLOW_QUERIES = "slow_queries";
const INDEX_STATS = "index_stats";
const STORAGE_STATS = "storage_stats";
const DISK_USAGE = "disk_usage";
const OPLOG_WINDOW = "oplog_window";

const POLL_INTERVAL_STATS = 5 * 60 * 1000;
const POLL_INTERVAL_LOGS = 10 * 60 * 1000;
const POLL_INTERVAL_INDEXES = 10 * 60 * 1000;
const STORAGE_HOUR = 3; // run storage scan daily at 3 AM local time

const slowQuerySince = new Map();

// ─── $queryStats collector ──────────────────────────────────────────

const IGNORED_APP_PREFIXES = ["MongoDB Automation Agent", "MongoDB Monitoring Module"];

function isIgnoredApp(name) {
  if (!name) return false;
  return IGNORED_APP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isIgnoredNs(ns) {
  if (!ns) return false;
  const db = ns.split(".")[0];
  return SYSTEM_DBS.has(db);
}

function hashShape(shape) {
  return crypto.createHash("md5").update(JSON.stringify(shape)).digest("hex");
}

async function collectQueryStatsForHost(cluster, host) {
  const client = await ensureDirectConnected(cluster, host);
  const cursor = client.db("admin").aggregate([{ $queryStats: {} }], { cursor: {} });
  const entries = await cursor.toArray();

  if (!entries.length) return 0;

  const now = new Date();
  const docs = [];
  for (const entry of entries) {
    const app = entry.key?.client?.application?.name || null;
    if (isIgnoredApp(app)) continue;

    const ns =
      (entry.key?.queryShape?.cmdNs?.db || "") +
      "." +
      (entry.key?.queryShape?.cmdNs?.coll || "");
    if (isIgnoredNs(ns)) continue;

    docs.push({
      clusterId: cluster._id,
      clusterName: cluster.name,
      host,
      timestamp: now,
      appName: app,
      namespace: ns !== "." ? ns : null,
      queryShapeHash: hashShape(entry.key?.queryShape || {}),
      queryShape: entry.key?.queryShape || null,
      comment: entry.key?.comment || null,
      execCount: entry.metrics?.execCount || 0,
      totalExecMicros: entry.metrics?.totalExecMicros?.sum || 0,
      docsExamined: entry.metrics?.docsExamined?.sum || 0,
      keysExamined: entry.metrics?.keysExamined?.sum || 0,
      firstResponseExecMicros: {
        min: entry.metrics?.firstResponseExecMicros?.min || 0,
        max: entry.metrics?.firstResponseExecMicros?.max || 0,
        sum: entry.metrics?.firstResponseExecMicros?.sum || 0,
        sumOfSquares: entry.metrics?.firstResponseExecMicros?.sumOfSquares || 0,
      },
      lastExecutionMicros: entry.metrics?.lastExecutionMicros || 0,
    });
  }

  if (!docs.length) return 0;
  await getDb().collection(QUERY_STATS).insertMany(docs, { ordered: false });
  return docs.length;
}

async function collectQueryStats(cluster) {
  const topology = await getDb()
    .collection("topologies")
    .findOne({ clusterId: cluster._id });

  if (!topology || !topology.hosts.length) {
    const client = await ensureConnected(cluster);
    const cursor = client.db("admin").aggregate([{ $queryStats: {} }], { cursor: {} });
    const entries = await cursor.toArray();
    if (!entries.length) return 0;
    const now = new Date();
    const docs = entries
      .filter((e) => {
        if (isIgnoredApp(e.key?.client?.application?.name)) return false;
        const ns = (e.key?.queryShape?.cmdNs?.db || "") + "." + (e.key?.queryShape?.cmdNs?.coll || "");
        return !isIgnoredNs(ns);
      })
      .map((entry) => {
        const ns = (entry.key?.queryShape?.cmdNs?.db || "") + "." + (entry.key?.queryShape?.cmdNs?.coll || "");
        return {
          clusterId: cluster._id, clusterName: cluster.name, host: "unknown",
          timestamp: now, appName: entry.key?.client?.application?.name || null,
          namespace: ns !== "." ? ns : null,
          queryShapeHash: hashShape(entry.key?.queryShape || {}),
          queryShape: entry.key?.queryShape || null,
          comment: entry.key?.comment || null,
          execCount: entry.metrics?.execCount || 0,
          totalExecMicros: entry.metrics?.totalExecMicros?.sum || 0,
          docsExamined: entry.metrics?.docsExamined?.sum || 0,
          keysExamined: entry.metrics?.keysExamined?.sum || 0,
          firstResponseExecMicros: {
            min: entry.metrics?.firstResponseExecMicros?.min || 0,
            max: entry.metrics?.firstResponseExecMicros?.max || 0,
            sum: entry.metrics?.firstResponseExecMicros?.sum || 0,
            sumOfSquares: entry.metrics?.firstResponseExecMicros?.sumOfSquares || 0,
          },
          lastExecutionMicros: entry.metrics?.lastExecutionMicros || 0,
        };
      });
    if (!docs.length) return 0;
    await getDb().collection(QUERY_STATS).insertMany(docs, { ordered: false });
    return docs.length;
  }

  let total = 0;
  for (const host of topology.hosts) {
    try {
      const count = await collectQueryStatsForHost(cluster, host);
      total += count;
    } catch (err) {
      console.error(`[queryStats] ${cluster.name} host=${host}: ${err.message}`);
    }
  }
  return total;
}

async function collectQueryStatsAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const count = await collectQueryStats(cluster);
      console.log(`[queryStats] ${cluster.name}: ${count} entries collected (all nodes)`);
    } catch (err) {
      console.error(`[queryStats] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── Atlas Logs API collector ───────────────────────────────────────

function decryptField(val) {
  return val && isEncrypted(val) ? decrypt(val) : val;
}

async function collectSlowQueries(cluster) {
  if (!cluster.atlasProjectId || !cluster.atlasPublicKey || !cluster.atlasPrivateKey) {
    return 0;
  }

  const publicKey = cluster.atlasPublicKey;
  const privateKey = decryptField(cluster.atlasPrivateKey);
  const projectId = cluster.atlasProjectId;

  const topology = await getDb()
    .collection("topologies")
    .findOne({ clusterId: cluster._id });
  if (!topology || !topology.hosts.length) return 0;

  const allHosts = [topology.primary, ...topology.hosts.filter((h) => h !== topology.primary)].filter(Boolean);

  const clusterId = cluster._id.toString();
  const since = slowQuerySince.get(clusterId) || Date.now() - 24 * 60 * 60 * 1000;

  const now = new Date();
  const allDocs = [];

  for (const host of allHosts) {
    try {
      const url = new URL(
        `https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/processes/${host}/performanceAdvisor/slowQueryLogs`,
      );
      const duration = Date.now() - since;
      url.searchParams.set("since", since.toString());
      url.searchParams.set("duration", duration.toString());

      const resp = await digestFetch(url.toString(), publicKey, privateKey);
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[slowQueries] ${cluster.name} host=${host}: Atlas API ${resp.status}: ${text.slice(0, 120)}`);
        continue;
      }

      const data = await resp.json();
      const slowQueries = data.slowQueries || [];

      for (const sq of slowQueries) {
        const line = sq.line || "";
        const parsed = parseLogLine(line);
        if (isIgnoredApp(parsed.appName)) continue;
        const ns = sq.namespace || parsed.namespace || null;
        if (isIgnoredNs(ns)) continue;
        allDocs.push({
          clusterId: cluster._id,
          clusterName: cluster.name,
          host,
          timestamp: now,
          appName: parsed.appName || null,
          comment: parsed.comment || null,
          namespace: ns,
          millis: parsed.millis || 0,
          planSummary: parsed.planSummary || null,
          cpuNanos: parsed.cpuNanos || null,
          bytesRead: parsed.bytesRead || null,
          timeReadingMicros: parsed.timeReadingMicros || null,
          docsExamined: parsed.docsExamined || 0,
          keysExamined: parsed.keysExamined || 0,
          nreturned: parsed.nreturned || 0,
        });
      }
    } catch (err) {
      console.error(`[slowQueries] ${cluster.name} host=${host}: ${err.message}`);
    }
  }

  slowQuerySince.set(clusterId, Date.now());
  if (!allDocs.length) return 0;
  await getDb().collection(SLOW_QUERIES).insertMany(allDocs, { ordered: false });
  return allDocs.length;
}

function parseLogLine(line) {
  try {
    const log = JSON.parse(line);
    const a = log.attr || {};
    const cmd = a.command || {};
    const storage = a.storage?.data || {};
    return {
      appName: a.appName || cmd.appName || null,
      comment: cmd.comment || null,
      namespace: a.ns || null,
      millis: a.durationMillis || 0,
      planSummary: a.planSummary || null,
      cpuNanos: a.cpuNanos || 0,
      bytesRead: storage.bytesRead || 0,
      timeReadingMicros: storage.timeReadingMicros || 0,
      docsExamined: a.docsExamined || 0,
      keysExamined: a.keysExamined || 0,
      nreturned: a.nreturned || 0,
    };
  } catch {
    const extract = (pattern) => line.match(pattern)?.[1] || null;
    const extractNum = (pattern) => parseInt(extract(pattern) || "0", 10);
    return {
      appName: extract(/appName:"([^"]+)"/),
      comment: extract(/comment:"([^"]+)"/),
      namespace: extract(/(?:ns|namespace):\s*"?([^\s",]+)/),
      millis: extractNum(/(\d+)ms$/),
      planSummary: extract(/planSummary:\s*([A-Z_]+(?:\s*\{[^}]*\})?)/),
      cpuNanos: extractNum(/cpuNanos:(\d+)/),
      bytesRead: extractNum(/bytesRead:(\d+)/),
      timeReadingMicros: extractNum(/timeReadingMicros:(\d+)/),
      docsExamined: extractNum(/docsExamined:(\d+)/),
      keysExamined: extractNum(/keysExamined:(\d+)/),
      nreturned: extractNum(/nreturned:(\d+)/),
    };
  }
}

async function collectSlowQueriesAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const count = await collectSlowQueries(cluster);
      if (count > 0) {
        console.log(`[slowQueries] ${cluster.name}: ${count} entries collected`);
      }
    } catch (err) {
      console.error(`[slowQueries] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── $indexStats + redundant index collector ────────────────────────

const SYSTEM_DBS = new Set(["admin", "config", "local", "mongomonitor", "#mongodb-mcp"]);

function isRedundantPrefix(shortKey, longKey) {
  const shortFields = Object.entries(shortKey);
  const longFields = Object.entries(longKey);
  if (shortFields.length >= longFields.length) return false;
  return shortFields.every(([field, dir], i) => longFields[i] && longFields[i][0] === field && longFields[i][1] === dir);
}

async function collectIndexStatsForHost(cluster, host) {
  const client = await ensureDirectConnected(cluster, host);
  const adminDb = client.db("admin");
  const dbList = await adminDb.command({ listDatabases: 1, nameOnly: true });
  const dbNames = dbList.databases.map((d) => d.name).filter((n) => !SYSTEM_DBS.has(n));

  const now = new Date();
  const unusedDocs = [];
  const redundantDocs = [];

  for (const dbName of dbNames) {
    const db = client.db(dbName);
    let collections;
    try {
      collections = await db.listCollections({}, { nameOnly: true }).toArray();
    } catch { continue; }

    for (const collInfo of collections) {
      if (collInfo.name.startsWith("system.")) continue;
      const ns = `${dbName}.${collInfo.name}`;
      const coll = db.collection(collInfo.name);

      let stats;
      try {
        stats = await coll.aggregate([{ $indexStats: {} }]).toArray();
      } catch { continue; }

      const indexDefs = [];
      for (const s of stats) {
        indexDefs.push({ name: s.name, key: s.key, spec: s.spec || {} });

        if (s.name === "_id_") continue;
        const ops = s.accesses?.ops ?? 0;
        if (ops === 0) {
          unusedDocs.push({
            clusterId: cluster._id,
            clusterName: cluster.name,
            host,
            namespace: ns,
            indexName: s.name,
            key: s.key,
            totalOps: 0,
            statsSince: s.accesses?.since || now,
            timestamp: now,
          });
        }
      }

      for (let i = 0; i < indexDefs.length; i++) {
        if (indexDefs[i].name === "_id_") continue;
        for (let j = 0; j < indexDefs.length; j++) {
          if (i === j) continue;
          if (isRedundantPrefix(indexDefs[i].key, indexDefs[j].key)) {
            redundantDocs.push({
              clusterId: cluster._id,
              clusterName: cluster.name,
              host,
              namespace: ns,
              indexName: indexDefs[i].name,
              key: indexDefs[i].key,
              coveredBy: indexDefs[j].name,
              coveredByKey: indexDefs[j].key,
              timestamp: now,
            });
            break;
          }
        }
      }
    }
  }

  return { unusedDocs, redundantDocs };
}

async function collectIndexStatsAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const topology = await getDb().collection("topologies").findOne({ clusterId: cluster._id });
      const hosts = topology?.hosts?.length ? topology.hosts : [];
      if (!hosts.length) continue;

      await getDb().collection(INDEX_STATS).deleteMany({ clusterId: cluster._id });

      let totalUnused = 0;
      let totalRedundant = 0;

      // Collect $indexStats (unused) from all nodes
      for (const host of hosts) {
        try {
          const { unusedDocs } = await collectIndexStatsForHost(cluster, host);
          if (unusedDocs.length) {
            await getDb().collection(INDEX_STATS).insertMany(
              unusedDocs.map((d) => ({ ...d, type: "unused" })),
              { ordered: false },
            );
          }
          totalUnused += unusedDocs.length;
        } catch (err) {
          console.error(`[indexStats] ${cluster.name} host=${host}: ${err.message}`);
        }
      }

      // Redundant index detection only on primary (definitions are the same on all nodes)
      const primary = topology.primary || hosts[0];
      try {
        const { redundantDocs } = await collectIndexStatsForHost(cluster, primary);
        if (redundantDocs.length) {
          await getDb().collection(INDEX_STATS).insertMany(
            redundantDocs.map((d) => ({ ...d, type: "redundant" })),
            { ordered: false },
          );
        }
        totalRedundant = redundantDocs.length;
      } catch (err) {
        console.error(`[indexStats] ${cluster.name} redundant check failed: ${err.message}`);
      }
      console.log(`[indexStats] ${cluster.name}: ${totalUnused} unused, ${totalRedundant} redundant`);
    } catch (err) {
      console.error(`[indexStats] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── Storage / fragmentation collector (daily 3 AM) ─────────────────

async function collectStorageStats(cluster) {
  const client = await ensureConnected(cluster);
  const adminDb = client.db("admin");
  const dbList = await adminDb.command({ listDatabases: 1, nameOnly: true });
  const dbNames = dbList.databases.map((d) => d.name).filter((n) => !SYSTEM_DBS.has(n));

  const now = new Date();
  const docs = [];

  for (const dbName of dbNames) {
    const db = client.db(dbName);
    let collections;
    try {
      collections = await db.listCollections({}, { nameOnly: true }).toArray();
    } catch { continue; }

    for (const collInfo of collections) {
      if (collInfo.name.startsWith("system.")) continue;
      const ns = `${dbName}.${collInfo.name}`;

      try {
        const stats = await db.command({ collStats: collInfo.name });
        const dataSize = stats.size || 0;
        const storageSize = stats.storageSize || 0;
        const totalIndexSize = stats.totalIndexSize || 0;
        const docCount = stats.count || 0;
        const avgObjSize = stats.avgObjSize || 0;

        // Collection fragmentation via WiredTiger block-manager (same as x-ray)
        const wtBm = stats.wiredTiger?.["block-manager"] || {};
        const collReusable = wtBm["file bytes available for reuse"] || 0;
        const fragmentation = storageSize > 0
          ? Math.round((collReusable / storageSize) * 10000) / 100
          : 0;

        const indexToDataRatio = dataSize > 0
          ? Math.round((totalIndexSize / dataSize) * 1000) / 10
          : 0;

        // Per-index fragmentation via WiredTiger indexDetails
        const indexDetails = [];
        const wtIndexDetails = stats.indexDetails || {};
        const indexSizes = stats.indexSizes || {};
        for (const [name, size] of Object.entries(indexSizes)) {
          const idxWt = wtIndexDetails[name]?.["block-manager"] || {};
          const idxReusable = idxWt["file bytes available for reuse"] || 0;
          const idxFileSize = idxWt["file size in bytes"] || size || 0;
          const idxFrag = idxFileSize > 0
            ? Math.round((idxReusable / idxFileSize) * 10000) / 100
            : 0;
          indexDetails.push({
            name,
            sizeBytes: size,
            fileSize: idxFileSize,
            reusableBytes: idxReusable,
            fragmentationPct: idxFrag,
          });
        }

        docs.push({
          clusterId: cluster._id,
          clusterName: cluster.name,
          namespace: ns,
          database: dbName,
          collection: collInfo.name,
          timestamp: now,
          docCount,
          avgObjSize,
          dataSizeBytes: dataSize,
          storageSizeBytes: storageSize,
          collReusableBytes: collReusable,
          totalIndexSizeBytes: totalIndexSize,
          numIndexes: stats.nindexes || 0,
          fragmentationPct: fragmentation,
          indexToDataRatioPct: indexToDataRatio,
          indexDetails,
        });
      } catch { continue; }
    }
  }

  if (!docs.length) return 0;
  await getDb().collection(STORAGE_STATS).deleteMany({ clusterId: cluster._id });
  await getDb().collection(STORAGE_STATS).insertMany(docs, { ordered: false });
  return docs.length;
}

async function collectStorageStatsAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const count = await collectStorageStats(cluster);
      console.log(`[storageStats] ${cluster.name}: ${count} collections scanned`);
    } catch (err) {
      console.error(`[storageStats] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── HTTP Digest Auth for Atlas API ─────────────────────────────────

async function digestFetch(url, username, password) {
  const resp1 = await fetch(url, {
    headers: { Accept: "application/vnd.atlas.2023-01-01+json" },
  });

  if (resp1.status !== 401) return resp1;

  const wwwAuth = resp1.headers.get("www-authenticate") || "";
  const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] || "";
  const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] || "";
  const qop = wwwAuth.match(/qop="([^"]+)"/)?.[1] || "auth";

  const nc = "00000001";
  const cnonce = crypto.randomBytes(16).toString("hex");
  const uri = new URL(url).pathname + new URL(url).search;

  const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`GET:${uri}`).digest("hex");
  const response = crypto
    .createHash("md5")
    .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    .digest("hex");

  const authHeader =
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;

  return fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: "application/vnd.atlas.2023-01-01+json",
    },
  });
}

// ─── Disk usage collector (every 10 min) ─────────────────────────────

async function collectDiskUsage(cluster) {
  const client = await ensureConnected(cluster);
  const stats = await client.db("admin").command({ dbStats: 1 });
  const fsTotalSize = stats.fsTotalSize || 0;
  const fsUsedSize = stats.fsUsedSize || 0;
  const usagePct = fsTotalSize > 0
    ? Math.round((fsUsedSize / fsTotalSize) * 10000) / 100
    : 0;

  const doc = {
    clusterId: cluster._id,
    clusterName: cluster.name,
    timestamp: new Date(),
    fsTotalSizeBytes: fsTotalSize,
    fsUsedSizeBytes: fsUsedSize,
    fsFreeBytes: fsTotalSize - fsUsedSize,
    usagePct,
  };

  await getDb().collection(DISK_USAGE).insertOne(doc);
  return usagePct;
}

async function collectDiskUsageAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const pct = await collectDiskUsage(cluster);
      console.log(`[diskUsage] ${cluster.name}: ${pct}%`);
    } catch (err) {
      console.error(`[diskUsage] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── Oplog window collector (every 10 min) ───────────────────────────

async function collectOplogWindow(cluster) {
  const client = await ensureConnected(cluster);
  const oplog = client.db("local").collection("oplog.rs");

  const [oldest, newest] = await Promise.all([
    oplog.find().sort({ $natural: 1 }).limit(1).next(),
    oplog.find().sort({ $natural: -1 }).limit(1).next(),
  ]);

  if (!oldest || !newest) return null;

  const oldestSec = oldest.ts.getHighBits();
  const newestSec = newest.ts.getHighBits();
  const windowHours = Math.round(((newestSec - oldestSec) / 3600) * 10) / 10;

  const doc = {
    clusterId: cluster._id,
    clusterName: cluster.name,
    timestamp: new Date(),
    windowHours,
    oldestTs: new Date(oldestSec * 1000),
    newestTs: new Date(newestSec * 1000),
  };

  await getDb().collection(OPLOG_WINDOW).insertOne(doc);
  return windowHours;
}

async function collectOplogWindowAll() {
  const clusters = await getDb().collection(CLUSTERS).find().toArray();
  for (const cluster of clusters) {
    try {
      const hours = await collectOplogWindow(cluster);
      if (hours !== null) {
        const warn = hours < 48 ? " ⚠ LOW" : "";
        console.log(`[oplogWindow] ${cluster.name}: ${hours}h${warn}`);
      }
    } catch (err) {
      console.error(`[oplogWindow] ${cluster.name} failed:`, err.message);
    }
  }
}

// ─── Polling engine ─────────────────────────────────────────────────

let statsTimer = null;
let logsTimer = null;
let indexTimer = null;
let storageTimer = null;
let diskTimer = null;
let oplogTimer = null;

function msUntilNextHour(hour) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

function startPolling() {
  console.log(
    `Polling started: $queryStats+topology every ${POLL_INTERVAL_STATS / 1000}s, Atlas logs every ${POLL_INTERVAL_LOGS / 1000}s, indexStats every ${POLL_INTERVAL_INDEXES / 1000}s, storageStats daily at ${STORAGE_HOUR}:00`,
  );

  const runStats = async () => {
    await collectQueryStatsAll();
    await discoverAll();
  };

  const runLogs = async () => {
    await collectSlowQueriesAll();
  };

  const runIndexes = async () => {
    await collectIndexStatsAll();
  };

  const runStorage = async () => {
    await collectStorageStatsAll();
  };

  const runDisk = async () => {
    await collectDiskUsageAll();
  };

  const runOplog = async () => {
    await collectOplogWindowAll();
  };

  runStats().catch((err) => console.error("[polling] stats error:", err.message));
  runLogs().catch((err) => console.error("[polling] logs error:", err.message));
  runIndexes().catch((err) => console.error("[polling] index error:", err.message));
  runDisk().catch((err) => console.error("[polling] disk error:", err.message));
  runOplog().catch((err) => console.error("[polling] oplog error:", err.message));

  // Run storage on startup only if no data exists yet, otherwise wait for 3 AM
  getDb().collection(STORAGE_STATS).countDocuments().then((count) => {
    if (count === 0) {
      console.log("[storageStats] No data yet — running initial collection");
      runStorage().catch((err) => console.error("[polling] storage error:", err.message));
    }
  }).catch(() => {});

  function scheduleStorage() {
    const delay = msUntilNextHour(STORAGE_HOUR);
    const nextRun = new Date(Date.now() + delay);
    console.log(`[storageStats] Next run at ${nextRun.toLocaleString()}`);
    storageTimer = setTimeout(() => {
      runStorage().catch((err) => console.error("[polling] storage error:", err.message));
      scheduleStorage();
    }, delay);
  }
  scheduleStorage();

  statsTimer = setInterval(
    () => runStats().catch((err) => console.error("[polling] stats error:", err.message)),
    POLL_INTERVAL_STATS,
  );
  logsTimer = setInterval(
    () => runLogs().catch((err) => console.error("[polling] logs error:", err.message)),
    POLL_INTERVAL_LOGS,
  );
  indexTimer = setInterval(
    () => runIndexes().catch((err) => console.error("[polling] index error:", err.message)),
    POLL_INTERVAL_INDEXES,
  );
  diskTimer = setInterval(
    () => runDisk().catch((err) => console.error("[polling] disk error:", err.message)),
    POLL_INTERVAL_LOGS,
  );
  oplogTimer = setInterval(
    () => runOplog().catch((err) => console.error("[polling] oplog error:", err.message)),
    POLL_INTERVAL_LOGS,
  );
}

function stopPolling() {
  if (statsTimer) clearInterval(statsTimer);
  if (logsTimer) clearInterval(logsTimer);
  if (indexTimer) clearInterval(indexTimer);
  if (storageTimer) clearTimeout(storageTimer);
  if (diskTimer) clearInterval(diskTimer);
  if (oplogTimer) clearInterval(oplogTimer);
  statsTimer = null;
  logsTimer = null;
  indexTimer = null;
  storageTimer = null;
  diskTimer = null;
  oplogTimer = null;
}

module.exports = { collectQueryStats, collectSlowQueries, startPolling, stopPolling };
