const crypto = require("crypto");
const { getDb } = require("./db");
const { ensureConnected, ensureDirectConnected } = require("./pool-cache");
const { decrypt, isEncrypted } = require("./crypto");
const { discoverAll } = require("./discovery");

const CLUSTERS = "clusters";
const QUERY_STATS = "query_stats";
const SLOW_QUERIES = "slow_queries";

const POLL_INTERVAL_STATS = 5 * 60 * 1000;
const POLL_INTERVAL_LOGS = 10 * 60 * 1000;

const slowQuerySince = new Map();

// ─── $queryStats collector ──────────────────────────────────────────

const IGNORED_APP_PREFIXES = ["MongoDB Automation Agent", "MongoDB Monitoring Module"];

function isIgnoredApp(name) {
  if (!name) return false;
  return IGNORED_APP_PREFIXES.some((prefix) => name.startsWith(prefix));
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
      .filter((e) => !isIgnoredApp(e.key?.client?.application?.name))
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
        allDocs.push({
          clusterId: cluster._id,
          clusterName: cluster.name,
          host,
          timestamp: now,
          appName: parsed.appName || null,
          comment: parsed.comment || null,
          namespace: sq.namespace || parsed.namespace || null,
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

// ─── Polling engine ─────────────────────────────────────────────────

let statsTimer = null;
let logsTimer = null;

function startPolling() {
  console.log(
    `Polling started: $queryStats+topology every ${POLL_INTERVAL_STATS / 1000}s, Atlas logs every ${POLL_INTERVAL_LOGS / 1000}s`,
  );

  const runStats = async () => {
    await collectQueryStatsAll();
    await discoverAll();
  };

  const runLogs = async () => {
    await collectSlowQueriesAll();
  };

  runStats().catch((err) => console.error("[polling] stats error:", err.message));
  runLogs().catch((err) => console.error("[polling] logs error:", err.message));

  statsTimer = setInterval(
    () => runStats().catch((err) => console.error("[polling] stats error:", err.message)),
    POLL_INTERVAL_STATS,
  );
  logsTimer = setInterval(
    () => runLogs().catch((err) => console.error("[polling] logs error:", err.message)),
    POLL_INTERVAL_LOGS,
  );
}

function stopPolling() {
  if (statsTimer) clearInterval(statsTimer);
  if (logsTimer) clearInterval(logsTimer);
  statsTimer = null;
  logsTimer = null;
}

module.exports = { collectQueryStats, collectSlowQueries, startPolling, stopPolling };
