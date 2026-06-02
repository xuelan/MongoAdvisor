/**
 * Build a self-contained HTML report.
 *
 * Reads `public/report.html`, `public/style.css`, and `public/report.js` once at startup
 * (re-reads on every call in development to avoid restart-edit churn — controlled via NODE_ENV).
 *
 * Transformations:
 *  - Inlines the CSS into a `<style>` tag (replaces the `<link rel="stylesheet">`).
 *  - Inlines the JS into a `<script>` tag (replaces the `<script src="report.js">`).
 *  - **Strips the Chart.js CDN tag** so the offline file doesn't try to reach the network;
 *    `report.js` detects `window.Chart` is undefined and routes every chart call through
 *    its inline-SVG fallback.
 *  - Removes the header nav pills (no `/` to navigate back to from a disk file) and the
 *    list view (only the single-report tabs are useful here).
 *  - Embeds the report JSON in `<script type="application/json" id="reportData">…</script>`.
 *
 * The result is a single .html file ~50-150 KB that opens identically online and offline.
 */

const fs = require("fs");
const path = require("path");
const { enrichNormalizedCache } = require("./enrich-cache");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const DEV = process.env.NODE_ENV !== "production";

let cachedTemplate = null;
let cachedCss = null;
let cachedJs = null;

function readPublic(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
}

function getAssets() {
  if (DEV || !cachedTemplate) {
    cachedTemplate = readPublic("report.html");
    cachedCss = readPublic("style.css");
    cachedJs = readPublic("report.js");
  }
  return { template: cachedTemplate, css: cachedCss, js: cachedJs };
}

/** Replace the stylesheet `<link>` with an inline `<style>` block. */
function inlineCss(html, css) {
  return html.replace(
    /<link\s+rel="stylesheet"\s+href="style\.css"\s*\/?>/,
    `<style>\n${css}\n</style>`,
  );
}

/** Remove the Chart.js CDN tag — the embedded JS falls back to inline SVG. */
function stripChartCdn(html) {
  return html.replace(
    /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4"\s*><\/script>\s*/,
    "",
  );
}

/** Replace `<script src="report.js"></script>` with an inline `<script>` block. */
function inlineJs(html, js) {
  return html.replace(
    /<script\s+src="report\.js"\s*><\/script>/,
    `<script>\n${js}\n</script>`,
  );
}

/** Trim view-switch noise that doesn't make sense offline. */
function trimForOffline(html) {
  html = html.replace(/<html(\s[^>]*)?>/i, (m) =>
    m.includes("report-embedded") ? m : m.replace("<html", '<html class="report-embedded"'),
  );
  // Hide the list view entirely (no /api to talk to).
  html = html.replace(
    /<div id="reportListView" hidden>[\s\S]*?<\/div>\s*<!-- SINGLE REPORT view/,
    '<!-- SINGLE REPORT view',
  );
  // The top nav pills point to / — keep them but make them static labels.
  html = html.replace(
    /<nav class="top-pills"[\s\S]*?<\/nav>/,
    '<nav class="top-pills" aria-label="Primary"><span class="btn-filter">Offline report</span></nav>',
  );
  // Re-label the health badge — there is no /api/health in offline mode. Keep the id
  // attribute so `report.js#boot()` can still find it.
  html = html.replace(
    /<span class="badge" id="mongoStatus">[^<]*<\/span>/,
    '<span class="badge" id="mongoStatus">offline</span>',
  );
  // No Back-to-list link makes sense offline.
  html = html.replace(
    /<a class="btn-secondary btn" href="\/report\.html">Back to list<\/a>\s*/,
    "",
  );
  // Drop the Download HTML link — they already have the file.
  html = html.replace(
    /<a class="btn" id="rsDownload"[^>]*>Download HTML<\/a>\s*/,
    "",
  );
  return html;
}

/**
 * Embed the report JSON as a `<script type="application/json" id="reportData">`. The page's
 * `report.js` reads this on boot and skips all `fetch()` calls.
 *
 * Important: we use a JSON-safe string — `</script>` inside the payload would close our tag,
 * so we escape `<` to `\u003c`.
 */
/**
 * Trim WiredTiger / serverStatus branches the report UI doesn't render. The full raw EJSON
 * is still available server-side in `reports_raw` — this function only slims the data
 * that gets embedded into the downloadable HTML and shipped to the browser.
 *
 * Without this, a 161-collection capture produces a ~3 MB HTML file (every collStats
 * carries hundreds of `wiredTiger.*` counters). With this, it's ~10× smaller.
 */
/** Keep only fields the Indexes tab chart and IndexInfo checks need. */
function slimIndexStats(batch) {
  if (!Array.isArray(batch) || batch.length === 0) return undefined;
  return batch.map((entry) => ({
    name: entry?.name,
    key: entry?.key,
    stats: (entry?.stats || []).map((h) => ({
      host: h?.host,
      accesses: h?.accesses,
      since: h?.since,
    })),
  }));
}

function slimNormalized(reportDoc) {
  const out = JSON.parse(JSON.stringify(reportDoc));
  for (const entry of out.normalized || []) {
    const n = entry.normalized;
    if (!n) continue;

    if (n.server?.serverStatus) {
      const ss = n.server.serverStatus;
      n.server.serverStatus = {
        host: ss.host,
        version: ss.version,
        process: ss.process,
        uptime: ss.uptime,
        localTime: ss.localTime,
        connections: ss.connections,
        catalogStats: ss.catalogStats,
        metrics: {
          queryExecutor: ss.metrics?.queryExecutor,
          document: ss.metrics?.document,
        },
        wiredTiger: ss.wiredTiger
          ? {
              cache: {
                "bytes read into cache":
                  ss.wiredTiger.cache?.["bytes read into cache"],
                "bytes currently in the cache":
                  ss.wiredTiger.cache?.["bytes currently in the cache"],
                "maximum bytes configured":
                  ss.wiredTiger.cache?.["maximum bytes configured"],
              },
            }
          : null,
      };
    }

    for (const db of n.databases || []) {
      for (const coll of db.collections) {
        if (!coll.stats) continue;
        const s = coll.stats;
        const wtFree = s.wiredTiger?.["block-manager"]?.["file bytes available for reuse"];
        const wtCache = s.wiredTiger?.cache?.["bytes currently in the cache"];
        const wt = {};
        if (wtFree != null) {
          wt["block-manager"] = { "file bytes available for reuse": wtFree };
        }
        if (wtCache != null) {
          wt.cache = { "bytes currently in the cache": wtCache };
        }
        coll.stats = {
          ns: s.ns,
          count: s.count,
          size: s.size,
          storageSize: s.storageSize,
          avgObjSize: s.avgObjSize,
          totalIndexSize: s.totalIndexSize,
          nindexes: s.nindexes,
          capped: s.capped,
          scaleFactor: s.scaleFactor,
          indexSizes: s.indexSizes,
          wiredTiger: Object.keys(wt).length > 0 ? wt : null,
        };
        const slimStats = slimIndexStats(coll.indexStats);
        if (slimStats) coll.indexStats = slimStats;
        else delete coll.indexStats;
        if (Array.isArray(coll.indexes) && coll.indexes.length > 0) {
          coll.indexes = coll.indexes.map((idx) => ({
            name: idx?.name,
            key: idx?.key,
          }));
        }
      }
    }
  }
  return out;
}

function embedJson(html, reportDoc) {
  const slim = slimNormalized({
    _id: reportDoc._id,
    name: reportDoc.name,
    createdAt: reportDoc.createdAt,
    topology: reportDoc.topology,
    setName: reportDoc.setName,
    nodes: reportDoc.nodes,
    normalized: reportDoc.normalized,
    groups: reportDoc.groups,
    findings: reportDoc.findings,
    summary: reportDoc.summary,
    meta: reportDoc.meta,
  });
  const json = JSON.stringify(slim).replace(/</g, "\\u003c");
  return html.replace(
    /<!--\s*<script type="application\/json" id="reportData"><\/script>\s*-->/,
    `<script type="application/json" id="reportData">${json}</script>`,
  );
}

/**
 * @param {object} reportDoc
 * @param {{ rawEjsonTexts?: string[] }} [options] — when set, backfill missing
 *   per-collection cache bytes from getMongoData raw uploads before slimming.
 */
function buildSelfContained(reportDoc, options = {}) {
  const rawTexts = options.rawEjsonTexts || [];
  const doc =
    rawTexts.length > 0 ? enrichNormalizedCache(reportDoc, rawTexts) : reportDoc;
  const { template, css, js } = getAssets();
  let html = template;
  html = inlineCss(html, css);
  html = stripChartCdn(html);
  html = inlineJs(html, js);
  html = trimForOffline(html);
  html = embedJson(html, doc);
  return html;
}

module.exports = { buildSelfContained, slimNormalized, enrichNormalizedCache };
