const API = window.location.origin;

const CHART_COLORS = ["#00ed64", "#00a3ff", "#ff6b6b", "#ffd93d", "#6c5ce7", "#a29bfe", "#fd79a8", "#00cec9", "#e17055", "#55efc4"];

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: true,
  plugins: {
    legend: { labels: { color: "#8899a6", font: { size: 11 } } },
  },
};

// ─── State ──────────────────────────────────────────────────────────
let clusters = [];
let topologyMap = {};
let appLoadExecChart = null;
let appLoadTimeChart = null;
let slowestAppChart = null;
let bubbleChart = null;
let treemapIOChart = null;
let treemapCPUChart = null;
/** Latest rows from `/api/metrics/unused-indexes` for script generation (deduped by namespace + index name). */
let cachedUnusedIndexes = null;

function shortName(name, max) {
  if (!name) return "(no appName)";
  return name.length > max ? name.slice(0, max - 2) + "…" : name;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function rebuildChart(existing, canvasId, config) {
  if (existing) existing.destroy();
  return new Chart(document.getElementById(canvasId), config);
}

function destroyCharts(charts) {
  for (const c of charts) { if (c) c.destroy(); }
}

// ─── Health ─────────────────────────────────────────────────────────
const MSG_DB_DOWN =
  "MongoAdvisor cannot connect to its application database right now. The dashboard may be incomplete or stale. This page will keep checking automatically.";
const MSG_API_UNEXPECTED =
  "The MongoAdvisor API returned an error. Some features may be unavailable until the service recovers.";
const MSG_API_UNREACHABLE =
  "Cannot reach the MongoAdvisor server. Ensure it is running and reachable from your browser. This page will keep checking automatically.";

function setDbBannerVisible(visible, message) {
  const banner = document.getElementById("dbUnavailableBanner");
  const textEl = document.getElementById("dbUnavailableText");
  if (!banner || !textEl) return;
  if (visible) {
    textEl.textContent = message;
    banner.hidden = false;
    banner.setAttribute("aria-hidden", "false");
  } else {
    banner.hidden = true;
    banner.setAttribute("aria-hidden", "true");
    textEl.textContent = "";
  }
}

async function checkHealth() {
  const badge = document.getElementById("mongoStatus");
  const dot = document.getElementById("statusDot");
  const setConnected = () => {
    badge.textContent = "Connected";
    badge.className = "badge ok";
    dot.style.background = "#00ed64";
    setDbBannerVisible(false);
  };
  const setDisconnected = (badgeLabel, bannerMessage) => {
    badge.textContent = badgeLabel;
    badge.className = "badge err";
    dot.style.background = "#ff5050";
    if (bannerMessage) setDbBannerVisible(true, bannerMessage);
    else setDbBannerVisible(false);
  };

  try {
    const res = await fetch(`${API}/api/health`);
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }

    if (res.ok && data.status === "ok") {
      setConnected();
      return;
    }

    if (res.status === 503 || data.mongo === "disconnected" || data.status === "error") {
      setDisconnected("Disconnected", MSG_DB_DOWN);
      return;
    }

    setDisconnected("Disconnected", MSG_API_UNEXPECTED);
  } catch {
    setDisconnected("Unreachable", MSG_API_UNREACHABLE);
  }
}

// ─── Topologies ─────────────────────────────────────────────────────
async function loadTopologies() {
  try {
    const res = await fetch(`${API}/api/topologies`);
    const topos = await res.json();
    topologyMap = {};
    for (const t of topos) topologyMap[t.clusterId] = t;
  } catch { /* ignore */ }
}

/** Small badge shown next to the cluster name in the list to flag protected environments. */
function renderEnvBadge(env) {
  const v = (env || "dev").toLowerCase();
  if (v === "production") {
    return '<span class="env-badge env-prod" title="Explain on this cluster requires explicit confirmation">PROD</span>';
  }
  if (v === "staging") {
    return '<span class="env-badge env-staging" title="Staging environment">STG</span>';
  }
  return '<span class="env-badge env-dev" title="Development environment">DEV</span>';
}

function renderTopology(clusterId) {
  const t = topologyMap[clusterId];
  if (!t || !t.hosts.length)
    return '<div class="topology">No topology discovered yet</div>';

  const clusterObj = clusters.find((c) => String(c._id) === String(clusterId));
  let uriPrefix = t.uriPrefix || null;
  if (!uriPrefix && clusterObj && clusterObj.uri) {
    try {
      const sanitized = clusterObj.uri.replace(/\/\/[^@]+@/, "//x@");
      uriPrefix = new URL(sanitized).hostname.split(".")[0];
    } catch { /* ignore */ }
  }

  const hostMismatch = uriPrefix
    && t.hosts.length > 0
    && !t.hosts.some((h) => h.startsWith(uriPrefix + "-") || h.startsWith(uriPrefix + ":"));

  const members = t.hosts
    .map((h) => {
      const isPrimary = h === t.primary;
      const isUnknownPrimary = !t.primary && t.helloOk === false;
      const cls = isPrimary ? " primary" : "";
      const label = isPrimary ? `${shortHost(h)} (P)` : shortHost(h);
      return `<span class="topo-member${cls}" title="${h}">${label}</span>`;
    })
    .join("");

  const notes = [];
  if (hostMismatch) {
    notes.push(`<span class="topo-alias-note" title="Stored RS member names start with '${t.hosts[0].split(".")[0]}' but the cluster connects via '${uriPrefix}' DNS alias. Showing aliased hostnames.">⚠ aliased hostnames</span>`);
  }
  if (t.helloOk === false) {
    const errMsg = t.helloError ? String(t.helloError).replace(/"/g, "&quot;") : "Connection error";
    notes.push(`<span class="topo-error-note" title="${errMsg}">⚠ auth failed — verify connection string</span>`);
  }
  if (t.catalogTooLarge) {
    const colls = t.catalogStats?.collections ?? "?";
    const threshold = t.catalogThreshold || 10000;
    notes.push(`
      <span class="topo-catalog-warn-wrap">
        <span class="topo-catalog-warn">⚠ ${colls} collections — heavy scans skipped</span>
        <span class="info-btn-wrap">
          <button type="button" class="info-btn warn" aria-label="Why are scans skipped?">i</button>
          <div class="info-tooltip info-tooltip-wide">
            <strong>Large number of collections detected (${colls} > ${threshold}).</strong>
            Creating too many collections can decrease performance, so MongoAdvisor is skipping
            per-collection scans (storage, fragmentation, indexStats) on this cluster.
            <a href="https://www.mongodb.com/docs/manual/data-modeling/design-antipatterns/reduce-collections/#reduce-the-number-of-collections" target="_blank" rel="noopener">Reduce the Number of Collections — MongoDB Docs</a>
          </div>
        </span>
      </span>
    `);
  }

  return `<div class="topology">
    <div class="topo-members">${members}${notes.join("")}<button type="button" class="btn-discover" onclick="rediscover('${clusterId}')">Refresh</button></div>
  </div>`;
}

// ─── Filters ────────────────────────────────────────────────────────

// Keep in sync with src/hidden-dbs.js (HIDDEN_TOP_LEVEL_DBS)
const HIDDEN_DBS = ["admin", "config", "local", "mongoadvisor", "#mongodb-mcp"];
let allDatabases = [];
let visibleDatabases = [];
let allHosts = [];

const DASH_CLUSTER_LS = "mongoadvisor.dashboardClusterId";

function getDashboardClusterId() {
  const sel = document.getElementById("dashboardClusterSelect");
  if (!sel || sel.disabled || !sel.value) return "";
  return String(sel.value);
}

function dashboardClusterQuery() {
  const cid = getDashboardClusterId();
  if (!cid) return "";
  return `?${new URLSearchParams({ clusterId: cid }).toString()}`;
}

function isHiddenDbName(db) {
  return HIDDEN_DBS.includes(db);
}

function getChecked(selector) {
  const boxes = document.querySelectorAll(`${selector} input[type=checkbox]`);
  return [...boxes].filter((b) => b.checked).map((b) => b.value);
}

function getSelectedDatabases() { return getChecked("#dbFilter"); }
function getSelectedHosts() { return getChecked("#hostFilter"); }

function getTimeRange() {
  return document.getElementById("timeRange").value;
}

document.getElementById("timeRangeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-val]");
  if (!btn) return;
  document.querySelectorAll("#timeRangeGroup .btn-filter").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("timeRange").value = btn.dataset.val;
  loadMetrics();
});

function metricsParams() {
  const params = new URLSearchParams();
  const cid = getDashboardClusterId();
  if (cid) params.set("clusterId", cid);
  for (const db of getSelectedDatabases()) params.append("database", db);
  for (const h of getSelectedHosts()) params.append("host", h);
  const range = getTimeRange();
  if (range) {
    const since = new Date(Date.now() - parseInt(range)).toISOString();
    params.set("since", since);
  }
  return params;
}

/** Index list APIs: host + optional database (prefix on namespace). Do not pass per-collection namespace — query_stats may omit cold collections but index_stats still has them. */
function indexListParams() {
  const params = new URLSearchParams();
  const cid = getDashboardClusterId();
  if (cid) params.set("clusterId", cid);
  for (const h of getSelectedHosts()) params.append("host", h);
  for (const db of getSelectedDatabases()) params.append("database", db);
  const q = params.toString();
  return q ? `?${q}` : "";
}

function shortHost(h) {
  return h.replace(/\.mongodb\.net:\d+$/, "").replace(/\.ljwx2$/, "");
}

async function loadHosts({ resetAll = false } = {}) {
  try {
    const res = await fetch(`${API}/api/metrics/hosts${dashboardClusterQuery()}`);
    allHosts = await res.json();
    const container = document.getElementById("hostFilter");
    const prev = getSelectedHosts();
    const isFirst = resetAll || container.children.length === 0;

    container.innerHTML = allHosts.map((h) => {
      const checked = isFirst ? true : prev.includes(h);
      return `<label class="ns-cb">
        <input type="checkbox" value="${h}"${checked ? " checked" : ""}> ${shortHost(h)}
      </label>`;
    }).join("");

    container.querySelectorAll("input").forEach((cb) => {
      cb.addEventListener("change", () => loadMetrics());
    });
  } catch { /* ignore */ }
}

async function loadDatabases({ resetAll = false } = {}) {
  try {
    const res = await fetch(`${API}/api/metrics/databases${dashboardClusterQuery()}`);
    allDatabases = await res.json();
    visibleDatabases = allDatabases.filter((db) => !isHiddenDbName(db));
    const container = document.getElementById("dbFilter");
    const prev = getSelectedDatabases();
    const isFirst = resetAll || container.children.length === 0;

    container.innerHTML = visibleDatabases.map((db) => {
      const checked = isFirst ? true : prev.includes(db);
      return `<label class="ns-cb">
        <input type="checkbox" value="${db}"${checked ? " checked" : ""}> ${db}
      </label>`;
    }).join("");

    container.querySelectorAll("input").forEach((cb) => {
      cb.addEventListener("change", () => loadMetrics());
    });
  } catch { /* ignore */ }
}

function dbSelectAll() {
  document.querySelectorAll("#dbFilter input").forEach((cb) => { cb.checked = true; });
  loadMetrics();
}
function dbSelectNone() {
  document.querySelectorAll("#dbFilter input").forEach((cb) => { cb.checked = false; });
  loadMetrics();
}
function hostSelectAll() {
  document.querySelectorAll("#hostFilter input").forEach((cb) => { cb.checked = true; });
  loadMetrics();
}
function hostSelectNone() {
  document.querySelectorAll("#hostFilter input").forEach((cb) => { cb.checked = false; });
  loadMetrics();
}

// ─── Metrics ────────────────────────────────────────────────────────

/** Toggle the per-card "$queryStats not available" notice on the three queryStats-driven
 *  cards (Execution Count, Total Time, Slowest by AppName). When the cluster is below 7.1
 *  (manual minimum for `$queryStats`) we hide the canvas and show the message in place. */
function updateQueryStatsUnsupportedBanner() {
  const cid = getDashboardClusterId();
  const t = cid ? topologyMap[cid] : null;
  const unsupported = !!(t && t.queryStatsSupported === false);
  const versionLabel = `MongoDB ${t?.serverVersion || "<unknown version>"}`;

  document.querySelectorAll(".qs-card").forEach((card) => {
    const msg = card.querySelector(".qs-unsupported-card-msg");
    const canvas = card.querySelector(".qs-canvas");
    if (msg) msg.hidden = !unsupported;
    if (canvas) canvas.hidden = unsupported;
    const verEl = msg?.querySelector(".qs-unsupported-version");
    if (verEl) verEl.textContent = versionLabel;
  });

  // When unsupported, destroy any leftover Chart.js instances so they don't render on the
  // hidden canvas and so the next switch back to a supported cluster rebuilds them cleanly.
  if (unsupported) {
    destroyCharts([appLoadExecChart, appLoadTimeChart, slowestAppChart]);
    appLoadExecChart = appLoadTimeChart = slowestAppChart = null;
  }
}

async function loadMetrics() {
  updateQueryStatsUnsupportedBanner();
  const cid = getDashboardClusterId();
  const t = cid ? topologyMap[cid] : null;
  const queryStatsUnsupported = !!(t && t.queryStatsSupported === false);

  if (!getSelectedDatabases().length || !getSelectedHosts().length) {
    destroyCharts([appLoadExecChart, appLoadTimeChart, slowestAppChart, bubbleChart, treemapIOChart, treemapCPUChart]);
    appLoadExecChart = appLoadTimeChart = slowestAppChart = bubbleChart = treemapIOChart = treemapCPUChart = null;
  } else {
    if (!queryStatsUnsupported) await loadAppLoad();
    await loadBubbleChart();
    await loadImpactChart();
  }
  await loadIndexAnalysis();
  await loadStorageStats();
}

// ─── App Load: Exec Count + Exec Time + Slowest ─────────────────────

async function loadAppLoad() {
  try {
    const res = await fetch(`${API}/api/metrics/app-load?${metricsParams()}`);
    const data = await res.json();
    if (!data.length) {
      destroyCharts([appLoadExecChart, appLoadTimeChart, slowestAppChart]);
      return;
    }

    const TOP_N = 20;

    // Top 20 by exec count
    const byExec = [...data].sort((a, b) => b.totalExecCount - a.totalExecCount).slice(0, TOP_N);
    const execLabels = byExec.map((d) => shortName(d.appName, 35));
    const execCounts = byExec.map((d) => d.totalExecCount);

    appLoadExecChart = rebuildChart(appLoadExecChart, "appLoadExecChart", {
      type: "bar",
      data: {
        labels: execLabels,
        datasets: [{ label: "Exec Count", data: execCounts, backgroundColor: CHART_COLORS.slice(0, execLabels.length), borderRadius: 4, maxBarThickness: 40 }],
      },
      options: {
        ...chartDefaults,
        scales: {
          x: { ticks: { color: "#8899a6", font: { size: 9 }, maxRotation: 45 }, grid: { display: false } },
          y: { ticks: { color: "#8899a6" }, grid: { color: "#1e3a4f" }, beginAtZero: true },
        },
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
      },
    });

    // Top 20 by total exec time
    const byTime = [...data].sort((a, b) => b.totalExecMicros - a.totalExecMicros).slice(0, TOP_N);
    const timeLabels = byTime.map((d) => shortName(d.appName, 35));
    const execMs = byTime.map((d) => Math.round(d.totalExecMicros / 1000));

    appLoadTimeChart = rebuildChart(appLoadTimeChart, "appLoadTimeChart", {
      type: "bar",
      data: {
        labels: timeLabels,
        datasets: [{ label: "Total Time (ms)", data: execMs, backgroundColor: CHART_COLORS.slice(0, timeLabels.length), borderRadius: 4, maxBarThickness: 40 }],
      },
      options: {
        ...chartDefaults,
        scales: {
          x: { ticks: { color: "#8899a6", font: { size: 9 }, maxRotation: 45 }, grid: { display: false } },
          y: { ticks: { color: "#8899a6" }, grid: { color: "#1e3a4f" }, beginAtZero: true },
        },
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
      },
    });

    // Top 20 by avg latency
    const withAvg = data.map((d) => ({
      label: shortName(d.appName, 35),
      val: d.totalExecCount > 0 ? Math.round(d.totalExecMicros / d.totalExecCount / 1000) : 0,
    }));
    const sorted = withAvg.sort((a, b) => b.val - a.val).slice(0, TOP_N);

    slowestAppChart = rebuildChart(slowestAppChart, "slowestAppChart", {
      type: "bar",
      data: {
        labels: sorted.map((s) => s.label),
        datasets: [{ label: "Avg Latency (ms)", data: sorted.map((s) => s.val), backgroundColor: sorted.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderRadius: 4, maxBarThickness: 40 }],
      },
      options: {
        ...chartDefaults,
        scales: {
          x: { ticks: { color: "#8899a6", font: { size: 9 }, maxRotation: 45 }, grid: { display: false } },
          y: { ticks: { color: "#8899a6" }, grid: { color: "#1e3a4f" }, beginAtZero: true },
        },
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
      },
    });
  } catch { /* ignore */ }
}

// ─── Bubble Chart: appName + comment ─────────────────────────────────

async function loadBubbleChart() {
  try {
    const res = await fetch(`${API}/api/metrics/bubble?${metricsParams()}`);
    const data = await res.json();
    if (!data.length) {
      destroyCharts([bubbleChart]);
      bubbleChart = null;
      return;
    }

    const maxTotal = Math.max(...data.map((d) => d.totalMillis), 1);
    const MIN_R = 5, MAX_R = 30;

    const points = data.map((d, i) => {
      const app = d.appName || "(no appName)";
      const comment = d.comment || "(no comment)";
      const label = `${shortName(app, 20)} | ${shortName(comment, 30)}`;
      const r = MIN_R + (d.totalMillis / maxTotal) * (MAX_R - MIN_R);
      return {
        x: d.count,
        y: d.avgMillis,
        r,
        label,
        appName: app,
        comment,
        rawAppName: d.appName || "",
        rawComment: d.comment || "",
        count: d.count,
        avgMillis: d.avgMillis,
        maxMillis: d.maxMillis,
        totalMillis: d.totalMillis,
        totalCpuMs: d.totalCpuMs,
        totalBytesReadMB: d.totalBytesReadMB,
        docsExamined: d.totalDocsExamined,
        keysExamined: d.totalKeysExamined,
        ns: (d.namespaces || []).filter(Boolean).join(", ") || "—",
        plans: (d.planSummaries || []).filter(Boolean).join(", ") || "—",
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "BB",
        borderColor: CHART_COLORS[i % CHART_COLORS.length],
      };
    });

    bubbleChart = rebuildChart(bubbleChart, "bubbleChart", {
      type: "bubble",
      data: {
        datasets: [{
          data: points,
          backgroundColor: points.map((p) => p.backgroundColor),
          borderColor: points.map((p) => p.borderColor),
          borderWidth: 1.5,
        }],
      },
      options: {
        ...chartDefaults,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: { display: true, text: "Slow Query Count", color: "#8899a6", font: { size: 11 } },
            ticks: { color: "#8899a6" },
            grid: { color: "#1e3a4f" },
            beginAtZero: true,
          },
          y: {
            title: { display: true, text: "Avg Latency (ms)", color: "#8899a6", font: { size: 11 } },
            ticks: { color: "#8899a6" },
            grid: { color: "#1e3a4f" },
            beginAtZero: true,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            external: (context) => renderBubbleTooltip(context),
          },
        },
      },
    });
  } catch (err) {
    console.error("bubble chart error:", err);
  }
}

/** Interactive HTML tooltip for the bubble chart — lets us host an Explain button
 *  (Chart.js default tooltips are not clickable). Mirrors the heatmap pattern. */
function renderBubbleTooltip(context) {
  const { chart, tooltip } = context;
  let el = chart.canvas.parentNode.querySelector(".treemap-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.className = "treemap-tooltip";
    chart.canvas.parentNode.style.position = "relative";
    chart.canvas.parentNode.appendChild(el);
    el._hovered = false;
    el.addEventListener("mouseenter", () => { el._hovered = true; });
    el.addEventListener("mouseleave", () => {
      el._hovered = false;
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    });
  }
  if (tooltip.opacity === 0) {
    if (el._hovered) return;
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      if (!el._hovered) { el.style.opacity = "0"; el.style.pointerEvents = "none"; }
    }, 300);
    return;
  }
  clearTimeout(el._hideTimer);
  const p = tooltip.dataPoints?.[0]?.raw;
  if (!p) { el.style.opacity = "0"; return; }

  const comment = p.comment || "(no comment)";
  let html = `<div class="tt-title">App: ${escHtml(p.appName || "—")}</div>`;
  html += `<div class="tt-entry">`;
  html += `<div class="tt-comment">${escHtml(comment)}</div>`;
  html += `<div class="tt-metric">Count: ${p.count}  |  Avg: ${p.avgMillis}ms  |  Max: ${p.maxMillis}ms</div>`;
  html += `<div class="tt-metric">Total: ${escHtml(formatNum(p.totalMillis))}ms  |  CPU: ${p.totalCpuMs}ms</div>`;
  html += `<div class="tt-metric">IO: ${p.totalBytesReadMB} MB  |  Docs: ${escHtml(formatNum(p.docsExamined))}  |  Keys: ${escHtml(formatNum(p.keysExamined))}</div>`;
  html += `<div class="tt-metric">NS: ${escHtml(p.ns)}</div>`;
  html += `<div class="tt-metric">Plan: ${escHtml(p.plans)}</div>`;
  html += `<div class="tt-explain-row">${explainButtonHtml({
    appName: p.rawAppName ?? "",
    comment: p.rawComment ?? "",
    namespace: pickFirstNs(p.ns),
  })}</div>`;
  html += `</div>`;
  el.innerHTML = html;
  el.style.opacity = "1";
  el.style.pointerEvents = "auto";
  const pos = tooltip.caretX;
  const mid = chart.width / 2;
  el.style.left = pos < mid ? (tooltip.caretX + 10) + "px" : "";
  el.style.right = pos >= mid ? (chart.width - tooltip.caretX + 10) + "px" : "";
  el.style.top = Math.max(0, tooltip.caretY - 40) + "px";
}

function pickFirstNs(nsStr) {
  if (!nsStr || nsStr === "—") return "";
  const first = String(nsStr).split(",")[0].trim();
  return first || "";
}

function explainButtonHtml({ appName, comment, namespace }) {
  const a = escHtml(appName || "");
  const c = escHtml(comment || "");
  const n = escHtml(namespace || "");
  return `<button type="button" class="btn-tt-explain js-open-explain" data-explain-app="${a}" data-explain-comment="${c}" data-explain-ns="${n}">Explain("executionStats")</button>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".js-open-explain");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openExplainModal({
    appName: btn.getAttribute("data-explain-app") || "",
    comment: btn.getAttribute("data-explain-comment") || "",
    namespace: btn.getAttribute("data-explain-ns") || "",
  });
});

// ─── Dual Treemaps: IO heatmap + CPU heatmap ────────────────────────

function lerpColor(a, b, t) {
  const [ar, ag, ab] = a, [br, bg, bb] = b;
  return `rgba(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)},0.88)`;
}

const IO_STOPS = [[30, 58, 79], [0, 163, 255], [108, 92, 231], [238, 90, 36]];
const CPU_STOPS = [[30, 58, 79], [255, 217, 61], [255, 107, 107], [255, 0, 110]];

function gradientColor(ratio, stops) {
  const r = Math.min(Math.max(ratio, 0), 1);
  const seg = (stops.length - 1) * r;
  const idx = Math.min(Math.floor(seg), stops.length - 2);
  const t = seg - idx;
  return lerpColor(stops[idx], stops[idx + 1], t);
}

function buildTreemapConfig(treeData, metricKey, colorStops, tooltipFn) {
  return {
    type: "treemap",
    data: {
      datasets: [{
        tree: treeData,
        key: "value",
        groups: ["appName", "queryLabel"],
        borderWidth: 2,
        borderColor: "#0f1923",
        spacing: 1,
        backgroundColor: (ctx) => {
          if (ctx.type !== "data") return "transparent";
          const d = ctx.raw?._data;
          if (!d) return "#1e3a4f66";
          if (d[metricKey] !== undefined) return gradientColor(d[metricKey], colorStops);
          if (d.children) {
            const avg = d.children.reduce((s, c) => s + (c[metricKey] || 0), 0) / (d.children.length || 1);
            return gradientColor(avg, colorStops);
          }
          return "#1e3a4f66";
        },
        hoverBackgroundColor: (ctx) => {
          if (ctx.type !== "data") return "transparent";
          return "#ffffff22";
        },
        labels: {
          display: true,
          align: "left",
          position: "top",
          color: ["#fff", "#ffffffaa"],
          font: [{ size: 11, weight: "bold" }, { size: 9 }],
          overflow: "fit",
          formatter: (ctx) => {
            if (ctx.type !== "data") return "";
            const d = ctx.raw?._data;
            if (d && d.queryLabel) return [d.queryLabel, d.count + " slow queries"];
            return [];
          },
        },
        captions: {
          display: true,
          align: "left",
          color: "#ffffffdd",
          font: { size: 12, weight: "bold" },
          padding: 4,
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: (context) => {
            const { chart, tooltip } = context;
            let el = chart.canvas.parentNode.querySelector(".treemap-tooltip");
            if (!el) {
              el = document.createElement("div");
              el.className = "treemap-tooltip";
              chart.canvas.parentNode.style.position = "relative";
              chart.canvas.parentNode.appendChild(el);
              el._hovered = false;
              el.addEventListener("mouseenter", () => { el._hovered = true; });
              el.addEventListener("mouseleave", () => {
                el._hovered = false;
                el.style.opacity = "0";
                el.style.pointerEvents = "none";
              });
            }
            if (tooltip.opacity === 0) {
              if (el._hovered) return;
              clearTimeout(el._hideTimer);
              el._hideTimer = setTimeout(() => {
                if (!el._hovered) { el.style.opacity = "0"; el.style.pointerEvents = "none"; }
              }, 300);
              return;
            }
            clearTimeout(el._hideTimer);
            const dps = tooltip.dataPoints || [];
            const deepest = dps.reduce((best, cur) => {
              const bl = best?.raw?.l ?? -1;
              const cl = cur?.raw?.l ?? -1;
              return cl > bl ? cur : best;
            }, null);
            const d = deepest?.raw?._data;
            if (!d) { el.style.opacity = "0"; return; }
            const isLeaf = !Array.isArray(d.children);
            const kids = isLeaf ? [d] : d.children;
            let html = `<div class="tt-title">App: ${escHtml(d.appName || kids[0]?.appName || "—")}</div>`;
            for (const kid of kids) {
              const comment = kid.fullComment || "(no comment)";
              const metrics = tooltipFn(kid);
              html += `<div class="tt-entry">`;
              html += `<div class="tt-comment">${escHtml(comment)}</div>`;
              html += metrics.map((l) => `<div class="tt-metric">${escHtml(l)}</div>`).join("");
              html += `<div class="tt-explain-row">${explainButtonHtml({
                appName: kid.rawAppName ?? (kid.appName === "(no appName)" ? "" : (kid.appName || "")),
                comment: kid.rawComment ?? (kid.fullComment === "(no comment)" ? "" : (kid.fullComment || "")),
                namespace: pickFirstNs(kid.ns || ""),
              })}</div>`;
              html += `</div>`;
            }
            el.innerHTML = html;
            el.style.opacity = "1";
            el.style.pointerEvents = "auto";
            const pos = tooltip.caretX;
            const mid = chart.width / 2;
            el.style.left = pos < mid ? (tooltip.caretX + 10) + "px" : "";
            el.style.right = pos >= mid ? (chart.width - tooltip.caretX + 10) + "px" : "";
            el.style.top = Math.max(0, tooltip.caretY - 40) + "px";
          },
        },
      },
    },
  };
}

function ioTooltip(d) {
  return [
    `Slow queries: ${d.count}  |  ns: ${d.ns}`,
    `── Total ──`,
    `  Bytes read: ${d.bytesReadMB} MB`,
    `  Docs examined: ${formatNum(d.docsExamined)}`,
    `── Per query avg ──`,
    `  Bytes read: ${d.avgBytesReadMB} MB`,
    `  Latency: ${d.avgMillis} ms`,
    `Plans: ${d.plans}`,
  ];
}

function cpuTooltip(d) {
  return [
    `Slow queries: ${d.count}  |  ns: ${d.ns}`,
    `── Total ──`,
    `  CPU: ${formatNum(d.cpuMs)} ms`,
    `  Exec time: ${formatNum(d.totalMillis)} ms`,
    `── Per query avg ──`,
    `  CPU: ${formatNum(d.avgCpuMs)} ms`,
    `  Latency: ${d.avgMillis} ms`,
    `  Max latency: ${formatNum(d.maxMillis)} ms`,
    `Plans: ${d.plans}`,
  ];
}

async function loadImpactChart() {
  try {
    const res = await fetch(`${API}/api/metrics/heatmap?${metricsParams()}`);
    const data = await res.json();
    if (!data.length) {
      destroyCharts([treemapIOChart, treemapCPUChart]);
      return;
    }

    const top = [...data].sort((a, b) => b.count - a.count).slice(0, 20);

    const maxBytes = Math.max(...top.map((d) => d.totalBytesRead), 1);
    const maxCpu = Math.max(...top.map((d) => d.totalCpuNanos), 1);

    const treeData = top.map((d) => {
      const app = d.appName || "(no appName)";
      const comment = d.comment || "(no comment)";
      const shortComment = comment.length > 40 ? comment.slice(0, 38) + "…" : comment;
      const ns = (d.namespaces || []).filter(Boolean).join(", ") || "—";
      return {
        appName: app,
        rawAppName: d.appName || "",
        rawComment: d.comment || "",
        tileLabel: `${app} — ${shortComment}`,
        queryLabel: shortComment,
        fullComment: comment,
        value: Math.max(d.count, 1),
        ioRatio: Math.min(d.totalBytesRead / maxBytes, 1),
        cpuRatio: Math.min(d.totalCpuNanos / maxCpu, 1),
        count: d.count,
        ns,
        bytesRead: d.totalBytesRead,
        bytesReadMB: d.totalBytesReadMB,
        avgBytesReadMB: d.avgBytesReadMB,
        cpuNanos: d.totalCpuNanos,
        cpuMs: d.totalCpuMs,
        avgCpuMs: d.avgCpuMs,
        docsExamined: d.totalDocsExamined,
        keysExamined: d.totalKeysExamined,
        totalMillis: d.totalMillis,
        avgMillis: d.avgMillis,
        maxMillis: d.maxMillis,
        plans: (d.planSummaries || []).filter(Boolean).join(", ") || "—",
      };
    });

    treemapIOChart = rebuildChart(treemapIOChart, "treemapIO",
      buildTreemapConfig(treeData, "ioRatio", IO_STOPS, ioTooltip));

    treemapCPUChart = rebuildChart(treemapCPUChart, "treemapCPU",
      buildTreemapConfig(treeData, "cpuRatio", CPU_STOPS, cpuTooltip));
  } catch (err) {
    console.error("treemap error:", err);
  }
}

// ─── Slow Queries ───────────────────────────────────────────────────

// ─── Index Analysis ─────────────────────────────────────────────────

async function loadIndexAnalysis() {
  await Promise.all([loadUnusedIndexes(), loadRedundantIndexes()]);
}

function splitNsForShell(ns) {
  if (!ns || typeof ns !== "string") return { db: "", coll: "" };
  const i = ns.indexOf(".");
  if (i <= 0) return { db: ns, coll: "" };
  return { db: ns.slice(0, i), coll: ns.slice(i + 1) };
}

function dedupeUnusedByNsName(rows) {
  const seen = new Map();
  for (const row of rows) {
    const k = `${row.namespace}\n${row.indexName}`;
    if (!seen.has(k)) seen.set(k, row);
  }
  return [...seen.values()];
}

function buildUnusedIndexShellScripts(kind, rows) {
  const header =
    "// [Warning] STAGING FIRST — review application queries, then test workload before production.\n" +
    "// Generated by MongoAdvisor — not executed here. Run in mongosh against the correct cluster.\n\n";
  const sample =
    header +
    (kind === "hide"
      ? "// Sample (replace database, collection, and index name):\n" +
        '// db.getSiblingDB("<database>").getCollection("<collection>").hideIndex("<indexName>");\n' +
        "// Unhide later: db.getSiblingDB(\"<database>\").getCollection(\"<collection>\").unhideIndex(\"<indexName>\");\n"
      : "// Sample (replace database, collection, and index name):\n" +
        '// db.getSiblingDB("<database>").getCollection("<collection>").dropIndex("<indexName>");\n');

  if (!rows || !rows.length) return sample;

  const unique = dedupeUnusedByNsName(rows);
  const lines = [header];
  for (const idx of unique) {
    const { db, coll } = splitNsForShell(idx.namespace);
    if (!db || !coll) continue;
    const inm = JSON.stringify(idx.indexName);
    if (kind === "hide") {
      lines.push(
        `// ${idx.namespace} — ${idx.indexName}\n` +
          `db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)}).hideIndex(${inm});\n`,
      );
    } else {
      lines.push(
        `// ${idx.namespace} — ${idx.indexName}\n` +
          `db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)}).dropIndex(${inm});\n`,
      );
    }
  }
  if (lines.length <= 1) return sample;
  return lines.join("\n");
}

function showUnusedIndexScriptPanel(kind) {
  const panel = document.getElementById("unusedIndexScriptPanel");
  const title = document.getElementById("unusedIndexScriptTitle");
  const warn = document.getElementById("unusedIndexScriptWarning");
  const pre = document.getElementById("unusedIndexScriptPre");
  const isHide = kind === "hide";
  title.textContent = isHide ? "mongosh — hide indexes" : "mongosh — drop indexes";
  warn.textContent =
    "[Warning] Run only in a non-production environment first. " +
    (isHide
      ? "Hidden indexes stay on disk but are ignored by the planner — verify behavior under real traffic."
      : "Dropping an index cannot be undone from this UI — ensure one full business cycle after hiding, if you used that workflow.");
  pre.textContent = buildUnusedIndexShellScripts(isHide ? "hide" : "drop", cachedUnusedIndexes || []);
  panel.hidden = false;
}

function hideUnusedIndexScriptPanel() {
  const panel = document.getElementById("unusedIndexScriptPanel");
  if (panel) panel.hidden = true;
}

async function loadUnusedIndexes() {
  const container = document.getElementById("unusedIndexList");
  try {
    const res = await fetch(`${API}/api/metrics/unused-indexes${indexListParams()}`);
    const data = await res.json();
    cachedUnusedIndexes = Array.isArray(data) ? data : [];
    if (!data.length) {
      container.innerHTML = '<div class="index-empty">No unused indexes detected</div>';
      return;
    }
    container.innerHTML = data.map((idx) => `
      <div class="index-item unused">
        <div class="idx-header">
          <span class="idx-ns">${idx.namespace}</span>
          <span class="idx-name">${idx.indexName}</span>
        </div>
        <div class="idx-details">
          <span>key: <code>${JSON.stringify(idx.key)}</code></span>
          <span>ops: ${idx.totalOps}</span>
          <span>host: ${idx.host ? shortHost(idx.host) : "—"}</span>
          <span>since: ${new Date(idx.statsSince).toLocaleDateString()}</span>
        </div>
      </div>
    `).join("");
  } catch {
    cachedUnusedIndexes = null;
    container.innerHTML = '<div class="index-empty">Failed to load</div>';
  }
}

document.getElementById("btnUnusedHideScripts")?.addEventListener("click", () => {
  showUnusedIndexScriptPanel("hide");
});
document.getElementById("btnUnusedDropScripts")?.addEventListener("click", () => {
  showUnusedIndexScriptPanel("drop");
});
document.getElementById("btnCloseUnusedScript")?.addEventListener("click", () => {
  hideUnusedIndexScriptPanel();
});
document.getElementById("btnCopyUnusedScript")?.addEventListener("click", async () => {
  const pre = document.getElementById("unusedIndexScriptPre");
  const text = pre ? pre.textContent : "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
});

async function loadRedundantIndexes() {
  const container = document.getElementById("redundantIndexList");
  try {
    const res = await fetch(`${API}/api/metrics/redundant-indexes${indexListParams()}`);
    const data = await res.json();
    if (!data.length) {
      container.innerHTML = '<div class="index-empty">No redundant indexes detected</div>';
      return;
    }
    container.innerHTML = data.map((idx) => `
      <div class="index-item redundant">
        <div class="idx-header">
          <span class="idx-ns">${idx.namespace}</span>
          <span class="idx-name">${idx.indexName}</span>
        </div>
        <div class="idx-details">
          <span>key: <code>${JSON.stringify(idx.key)}</code></span>
          <span class="idx-covered">covered by: <strong>${idx.coveredBy}</strong> <code>${JSON.stringify(idx.coveredByKey)}</code></span>
        </div>
      </div>
    `).join("");
  } catch {
    container.innerHTML = '<div class="index-empty">Failed to load</div>';
  }
}

// ─── Storage Table ──────────────────────────────────────────────────

function fmtBytes(b) {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(2) + " GB";
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

function fragClass(pct) {
  if (pct >= 50) return "frag-high";
  if (pct >= 25) return "frag-med";
  return "";
}

function idxRatioClass(pct) {
  if (pct >= 20) return "frag-high";
  if (pct >= 10) return "frag-med";
  return "";
}

let storageSortKey = "storageSizeBytes";
let storageSortAsc = false;
let storageData = [];
let storagePage = 0;
const STORAGE_PAGE_SIZE = 10;

function reusableClass(bytes) {
  if (bytes >= 100_000_000) return "reusable-high";
  if (bytes >= 10_000_000) return "reusable-med";
  return "";
}

function renderStorageTable() {
  const tbody = document.getElementById("storageBody");
  const emptyMsg = document.getElementById("storageEmpty");
  const table = document.getElementById("storageTable");
  const pager = document.getElementById("storagePager");
  const summary = document.getElementById("storageReusableSummary");

  if (summary) {
    const totalReusable = storageData.reduce((s, d) => s + (d.collReusableBytes || 0), 0);
    const totalGb = totalReusable / 1_073_741_824;
    summary.textContent = storageData.length
      ? `· total reusable: ${totalGb.toFixed(2)} GB`
      : "";
  }

  if (!storageData.length) {
    tbody.innerHTML = "";
    table.style.display = "none";
    emptyMsg.style.display = "";
    if (pager) pager.style.display = "none";
    return;
  }
  table.style.display = "";
  emptyMsg.style.display = "none";

  const sorted = [...storageData].sort((a, b) => {
    const av = a[storageSortKey], bv = b[storageSortKey];
    if (typeof av === "string") return storageSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return storageSortAsc ? av - bv : bv - av;
  });

  const totalPages = Math.ceil(sorted.length / STORAGE_PAGE_SIZE);
  if (storagePage >= totalPages) storagePage = totalPages - 1;
  if (storagePage < 0) storagePage = 0;
  const start = storagePage * STORAGE_PAGE_SIZE;
  const page = sorted.slice(start, start + STORAGE_PAGE_SIZE);

  tbody.innerHTML = page.map((d) => {
    const idxDetail = (d.indexDetails || [])
      .filter((i) => i.fragmentationPct > 0)
      .map((i) => `${i.name}: ${i.fragmentationPct}%`)
      .join(", ");
    const idxTitle = idxDetail ? `title="Index frag: ${idxDetail}"` : "";
    return `
    <tr ${idxTitle}>
      <td class="st-ns">${d.namespace}</td>
      <td>${formatNum(d.docCount)}</td>
      <td>${fmtBytes(d.dataSizeBytes)}</td>
      <td>${fmtBytes(d.storageSizeBytes)}</td>
      <td class="st-reusable ${reusableClass(d.collReusableBytes || 0)}">${fmtBytes(d.collReusableBytes || 0)}</td>
      <td class="st-frag ${fragClass(d.fragmentationPct)}">${d.fragmentationPct}%</td>
      <td>${fmtBytes(d.totalIndexSizeBytes)}</td>
      <td>${d.numIndexes > 10 ? '<span class="frag-high">' + d.numIndexes + "</span>" : d.numIndexes}</td>
      <td class="${idxRatioClass(d.indexToDataRatioPct)}">${d.indexToDataRatioPct}%</td>
    </tr>`;
  }).join("");

  if (pager) {
    if (totalPages <= 1) {
      pager.style.display = "none";
    } else {
      pager.style.display = "flex";
      pager.innerHTML = `
        <button class="btn-page" ${storagePage === 0 ? "disabled" : ""} onclick="storageGoPage(${storagePage - 1})">‹ Prev</button>
        <span class="page-info">${storagePage + 1} / ${totalPages} <span class="page-total">(${sorted.length} rows)</span></span>
        <button class="btn-page" ${storagePage >= totalPages - 1 ? "disabled" : ""} onclick="storageGoPage(${storagePage + 1})">Next ›</button>`;
    }
  }
}

function storageGoPage(p) {
  storagePage = p;
  renderStorageTable();
}

async function loadStorageStats() {
  try {
    const params = new URLSearchParams();
    const cid = getDashboardClusterId();
    if (cid) params.set("clusterId", cid);
    for (const db of getSelectedDatabases()) params.append("database", db);
    const q = params.toString();
    const res = await fetch(`${API}/api/metrics/storage${q ? `?${q}` : ""}`);
    storageData = await res.json();
    renderStorageTable();
  } catch {
    storageData = [];
    renderStorageTable();
  }
}

document.getElementById("storageTable").querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  if (storageSortKey === key) {
    storageSortAsc = !storageSortAsc;
  } else {
    storageSortKey = key;
    storageSortAsc = key === "namespace";
  }
  storagePage = 0;
  document.querySelectorAll("#storageTable th").forEach((t) => t.classList.remove("sorted-asc", "sorted-desc"));
  th.classList.add(storageSortAsc ? "sorted-asc" : "sorted-desc");
  renderStorageTable();
});

// ─── Clusters ───────────────────────────────────────────────────────

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

let clusterFormFeedbackTimer = null;
function showClusterFormFeedback(message, isError) {
  const el = document.getElementById("clusterFormFeedback");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.className = "cluster-form-feedback " + (isError ? "err" : "ok");
  clearTimeout(clusterFormFeedbackTimer);
  clusterFormFeedbackTimer = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
    el.className = "cluster-form-feedback";
  }, 6000);
}

function populateClusterEditSelect() {
  const sel = document.getElementById("clusterEditSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Select cluster…</option>';
  for (const c of clusters) {
    const opt = document.createElement("option");
    opt.value = c._id;
    opt.textContent = clusterDisplayName(clusters, c);
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/** Two registrations with the same name → show id tail (matches disk/oplog gauges). */
function clusterDisplayName(all, c) {
  const same = all.filter((x) => x.name === c.name).length;
  if (same > 1 && c._id) {
    return `${c.name} (${String(c._id).slice(-6)})`;
  }
  return c.name;
}

function populateDashboardClusterSelect() {
  const sel = document.getElementById("dashboardClusterSelect");
  if (!sel) return;
  if (!clusters.length) {
    sel.innerHTML = '<option value="">No clusters registered</option>';
    sel.disabled = true;
    localStorage.removeItem(DASH_CLUSTER_LS);
    return;
  }
  sel.disabled = false;
  sel.innerHTML = clusters
    .map(
      (c) =>
        `<option value="${escAttr(String(c._id))}">${escAttr(clusterDisplayName(clusters, c))}</option>`,
    )
    .join("");
  const stored = localStorage.getItem(DASH_CLUSTER_LS);
  const fallback = String(clusters[0]._id);
  const pick = stored && clusters.some((c) => String(c._id) === stored) ? stored : fallback;
  sel.value = pick;
  localStorage.setItem(DASH_CLUSTER_LS, pick);
}

async function loadClusters() {
  const list = document.getElementById("clusterList");
  try {
    await loadTopologies();
    const res = await fetch(`${API}/api/clusters`);
    clusters = await res.json();
    populateClusterEditSelect();
    if (!clusters.length) {
      list.innerHTML = '<li class="empty">No clusters registered yet.</li>';
      populateDashboardClusterSelect();
      return;
    }
    list.innerHTML = clusters
      .map((c) => {
        const displayName = clusterDisplayName(clusters, c);
        const pollingOff = c.isPolling === false;
        return `
      <li>
        <div class="cluster-header">
          <div>
            <span class="cluster-name">${displayName}</span>
            ${renderEnvBadge(c.environment)}
            ${pollingOff ? '<span class="cluster-polling-paused" title="Scheduled metrics collection is paused for this cluster">polling paused</span>' : ""}
            ${c.atlasProjectId ? `<a class="atlas-link" href="https://cloud.mongodb.com/v2/${c.atlasProjectId}#/clusters/detail/${c.name}" target="_blank">Atlas Console</a>` : ""}
          </div>
          <div class="cluster-header-actions">
            <button type="button" class="btn btn-sm ${pollingOff ? "btn-secondary" : ""}" onclick="toggleClusterPolling('${c._id}')">${pollingOff ? "Resume polling" : "Pause polling"}</button>
            <button type="button" class="btn btn-sm" onclick="removeCluster('${c._id}')">Remove</button>
          </div>
        </div>
        ${renderTopology(c._id)}
      </li>`;
      })
      .join("");
    populateDashboardClusterSelect();
  } catch {
    clusters = [];
    populateClusterEditSelect();
    list.innerHTML = '<li class="empty">Failed to load clusters.</li>';
    populateDashboardClusterSelect();
  }
}

async function rediscover(clusterId) {
  try {
    await fetch(`${API}/api/topologies/${clusterId}/discover`, { method: "POST" });
    loadClusters();
  } catch { /* ignore */ }
}

// ─── Form ───────────────────────────────────────────────────────────
document.getElementById("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const res = await fetch(`${API}/api/clusters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        uri: form.get("uri"),
        region: form.get("region"),
        environment: form.get("environment") || "dev",
        atlasProjectId: form.get("atlasProjectId") || undefined,
        atlasPublicKey: form.get("atlasPublicKey") || undefined,
        atlasPrivateKey: form.get("atlasPrivateKey") || undefined,
      }),
    });
    const errBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      showClusterFormFeedback(errBody.error || `Could not add cluster (${res.status})`, true);
      return;
    }
    e.target.reset();
    showClusterFormFeedback("Cluster registered — discovering topology…", false);
    // Show the newly-added cluster (without topology) right away, then re-load once discovery
    // finishes so the topology members appear without the user having to refresh.
    await loadClusters();
    setTimeout(() => {
      loadClusters();
      loadHosts({ resetAll: false });
      loadDatabases({ resetAll: false });
    }, 2500);
  } catch (err) {
    showClusterFormFeedback(err.message || "Network error", true);
  }
});

async function removeCluster(id) {
  await fetch(`${API}/api/clusters/${id}`, { method: "DELETE" });
  loadClusters();
}

async function toggleClusterPolling(id) {
  const c = clusters.find((x) => String(x._id) === String(id));
  const currentlyEnabled = c ? c.isPolling !== false : true;
  const next = !currentlyEnabled;
  try {
    const res = await fetch(`${API}/api/clusters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPolling: next }),
    });
    const errBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      showClusterFormFeedback(errBody.error || `Could not update polling (${res.status})`, true);
      return;
    }
    showClusterFormFeedback(next ? "Polling enabled for this cluster." : "Polling paused for this cluster.", false);
    await loadClusters();
  } catch (err) {
    showClusterFormFeedback(err.message || "Network error", true);
  }
}

document.getElementById("clusterEditSelect")?.addEventListener("change", async () => {
  const sel = document.getElementById("clusterEditSelect");
  const form = document.getElementById("clusterEditForm");
  if (!sel || !form) return;
  const id = sel.value;
  if (!id) {
    form.reset();
    return;
  }
  try {
    const res = await fetch(`${API}/api/clusters/${id}`);
    const c = await res.json();
    if (!res.ok) return;
    const q = (n) => form.querySelector(`[name="${n}"]`);
    if (q("name")) q("name").value = c.name || "";
    if (q("environment")) q("environment").value = c.environment || "dev";
    if (q("region")) q("region").value = c.region && c.region !== "unknown" ? c.region : "";
    if (q("uri")) q("uri").value = "";
    if (q("atlasProjectId")) q("atlasProjectId").value = c.atlasProjectId || "";
    if (q("atlasPublicKey")) q("atlasPublicKey").value = c.atlasPublicKey || "";
    if (q("atlasPrivateKey")) q("atlasPrivateKey").value = "";
  } catch {
    /* ignore */
  }
});

document.getElementById("clusterEditForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sel = document.getElementById("clusterEditSelect");
  const form = e.target;
  const id = sel?.value;
  if (!id) {
    showClusterFormFeedback("Select a cluster first.", true);
    return;
  }
  const fd = new FormData(form);
  const body = {
    name: (fd.get("name") || "").trim(),
    environment: (fd.get("environment") || "dev").trim(),
    region: (fd.get("region") || "").trim() || "unknown",
    atlasProjectId: (fd.get("atlasProjectId") || "").trim() || null,
    atlasPublicKey: (fd.get("atlasPublicKey") || "").trim() || null,
  };
  const uri = (fd.get("uri") || "").trim();
  if (uri) body.uri = uri;
  const apk = (fd.get("atlasPrivateKey") || "").trim();
  if (apk) body.atlasPrivateKey = apk;
  try {
    const res = await fetch(`${API}/api/clusters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const errBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      showClusterFormFeedback(errBody.error || `Update failed (${res.status})`, true);
      return;
    }
    form.querySelector('[name="uri"]').value = "";
    form.querySelector('[name="atlasPrivateKey"]').value = "";
    document.getElementById("clusterEditPanel")?.setAttribute("hidden", "");
    const hadUriChange = !!uri;
    showClusterFormFeedback(
      hadUriChange ? "Cluster updated — refreshing topology…" : "Cluster updated.",
      false,
    );
    // If URI changed, give the server a moment to finish re-discovering the topology
    if (hadUriChange) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    loadClusters();
    if (hadUriChange) {
      loadHosts({ resetAll: true });
      loadDatabases({ resetAll: true });
    }
  } catch (err) {
    showClusterFormFeedback(err.message || "Network error", true);
  }
});

document.getElementById("toggleEditClusterPanel")?.addEventListener("click", () => {
  const panel = document.getElementById("clusterEditPanel");
  if (!panel) return;
  const open = panel.hasAttribute("hidden");
  if (open) {
    panel.removeAttribute("hidden");
    document.getElementById("clusterEditSelect")?.focus();
  } else {
    panel.setAttribute("hidden", "");
  }
});

document.getElementById("cancelClusterEdit")?.addEventListener("click", () => {
  document.getElementById("clusterEditPanel")?.setAttribute("hidden", "");
});

// ─── Disk Usage ─────────────────────────────────────────────────────

/** Same display name for two registered clusters → disambiguate with id tail */
function gaugeClusterLabel(data, d) {
  const same = data.filter((x) => x.clusterName === d.clusterName).length;
  if (same > 1 && d.clusterId) {
    const id = String(d.clusterId);
    return `${d.clusterName} (${id.slice(-6)})`;
  }
  return d.clusterName;
}

function diskLevel(pct) {
  if (pct >= 85) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

async function loadDiskUsage() {
  const container = document.getElementById("diskUsageContent");
  try {
    const res = await fetch(`${API}/api/metrics/disk-usage${dashboardClusterQuery()}`);
    const data = await res.json();
    if (!data.length) {
      container.innerHTML = '<span class="empty">No disk data yet</span>';
      return;
    }
    const maxPct = Math.max(...data.map((d) => d.usagePct));
    const infoBtn = document.getElementById("diskInfoBtn");
    const tooltip = document.getElementById("diskInfoTooltip");
    if (maxPct >= 85) {
      infoBtn.className = "info-btn danger";
      tooltip.innerHTML = 'Your disk usage is above 85%. Please consider scaling your storage size urgently. <a href="https://www.mongodb.com/docs/atlas/customize-storage/#std-label-create-cluster-storage" target="_blank" rel="noopener">Learn more</a>';
    } else if (maxPct >= 70) {
      infoBtn.className = "info-btn warn";
      tooltip.innerHTML = 'Your disk usage is above 70%. Please consider scaling your storage size. <a href="https://www.mongodb.com/docs/atlas/customize-storage/#std-label-create-cluster-storage" target="_blank" rel="noopener">Learn more</a>';
    } else {
      infoBtn.className = "info-btn";
      tooltip.innerHTML = 'Disk usage is healthy. <a href="https://www.mongodb.com/docs/atlas/customize-storage/#std-label-create-cluster-storage" target="_blank" rel="noopener">Learn more about storage options</a>';
    }

    container.innerHTML = data.map((d) => {
      const lvl = diskLevel(d.usagePct);
      const label = gaugeClusterLabel(data, d);
      return `
        <div class="disk-gauge">
          <div class="disk-gauge-header">
            <span class="disk-gauge-name">${label}</span>
            <span class="disk-gauge-pct ${lvl}">${d.usagePct}%</span>
          </div>
          <div class="disk-bar"><div class="disk-bar-fill ${lvl}" style="width:${Math.min(d.usagePct, 100)}%"></div></div>
          <div class="disk-details">
            <span>Used: ${fmtBytes(d.fsUsedSizeBytes)}</span>
            <span>Free: ${fmtBytes(d.fsFreeBytes)}</span>
            <span>Total: ${fmtBytes(d.fsTotalSizeBytes)}</span>
          </div>
          <div class="disk-time">Updated: ${new Date(d.timestamp).toLocaleString()}</div>
        </div>`;
    }).join("");
  } catch {
    container.innerHTML = '<span class="empty">Failed to load disk data</span>';
  }
}

// ─── Oplog Window ───────────────────────────────────────────────────

function oplogLevel(hours) {
  if (hours < 48) return "danger";
  if (hours < 72) return "warn";
  return "ok";
}

async function loadOplogWindow() {
  const container = document.getElementById("oplogContent");
  try {
    const res = await fetch(`${API}/api/metrics/oplog-window${dashboardClusterQuery()}`);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      container.innerHTML = `<span class="empty">Failed to load oplog data: response was not JSON (HTTP ${res.status}). The API may have returned an HTML error page—check the MongoAdvisor server logs and application database connection.</span>`;
      return;
    }
    if (!Array.isArray(data)) {
      container.innerHTML = '<span class="empty">Failed to load oplog data: API returned an unexpected payload.</span>';
      return;
    }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && (data.error || data.message)) || `HTTP ${res.status}`;
      container.innerHTML = `<span class="empty">Failed to load oplog data: ${String(msg).replace(/</g, "&lt;")}</span>`;
      return;
    }
    if (!data.length) {
      container.innerHTML =
        '<span class="empty">No oplog data yet. The collector samples <code>local.oplog.rs</code> on a schedule; ensure clusters are replica sets and check server logs for <code>[oplogWindow]</code> errors.</span>';
      return;
    }
    const minHours = Math.min(...data.map((d) => d.windowHours));
    const oplogBtn = document.getElementById("oplogInfoBtn");
    const oplogTip = document.getElementById("oplogInfoTooltip");
    if (minHours < 48) {
      oplogBtn.className = "info-btn danger";
      oplogTip.innerHTML = 'Your Oplog Window is too small. A small window reduces resilience: any secondary or downstream consumer (Search, triggers, Sync, external pipelines) could be impacted. <a href="https://www.mongodb.com/docs/manual/core/replica-set-oplog/" target="_blank" rel="noopener">Learn more</a>';
    } else if (minHours < 72) {
      oplogBtn.className = "info-btn warn";
      oplogTip.innerHTML = 'Your Oplog Window is getting small. A small window reduces resilience: any secondary or downstream consumer (Search, triggers, Sync, external pipelines) could be impacted. <a href="https://www.mongodb.com/docs/manual/core/replica-set-oplog/" target="_blank" rel="noopener">Learn more</a>';
    } else {
      oplogBtn.className = "info-btn";
      oplogTip.innerHTML = 'Oplog window is healthy. <a href="https://www.mongodb.com/docs/manual/core/replica-set-oplog/" target="_blank" rel="noopener">Learn more about the oplog</a>';
    }

    container.innerHTML = data.map((d) => {
      const lvl = oplogLevel(d.windowHours);
      const maxBar = 168;
      const barPct = Math.min((d.windowHours / maxBar) * 100, 100);
      const label = gaugeClusterLabel(data, d);
      return `
        <div class="disk-gauge">
          <div class="disk-gauge-header">
            <span class="disk-gauge-name">${label}</span>
            <span class="disk-gauge-pct ${lvl}">${d.windowHours}h</span>
          </div>
          <div class="disk-bar"><div class="disk-bar-fill ${lvl}" style="width:${barPct}%"></div></div>
          <div class="disk-details">
            <span>Oldest: ${new Date(d.oldestTs).toLocaleString()}</span>
            <span>Newest: ${new Date(d.newestTs).toLocaleString()}</span>
          </div>
          ${d.windowHours < 48 ? '<div class="oplog-warn">Warning: oplog window below 48h — risk of replication issues</div>' : ""}
          <div class="disk-time">Updated: ${new Date(d.timestamp).toLocaleString()}</div>
        </div>`;
    }).join("");
  } catch {
    container.innerHTML =
      '<span class="empty">Failed to load oplog data: network error or request was blocked. Check that the MongoAdvisor server is reachable.</span>';
  }
}

// ─── Explain Modal ──────────────────────────────────────────────────

let explainCurrent = null;
/** Parsed command body from `/api/metrics/slow-query-sample`, used by the Run button. */
let explainCommandBody = null;
/** Namespace resolved from the slow-query sample (falls back to the tile's namespace). */
let explainNamespaceResolved = null;
/**
 * True when the slow-query log line was truncated by MongoDB (either the structured `truncated`
 * field is present or a `$truncated` placeholder is found anywhere in the captured command body).
 * When set, the captured command can't be re-run reliably on a target cluster — the modal disables
 * Run and tells the user to test the full query in MongoDB Compass instead.
 */
let explainSourceTruncated = false;

/** Look up the selected explain target cluster object (or null). */
function getExplainSelectedCluster() {
  const sel = document.getElementById("explainClusterSelect");
  const id = sel?.value;
  if (!id) return null;
  return clusters.find((c) => String(c._id) === String(id)) || null;
}

function isProductionEnv(c) {
  return !!c && c.environment === "production";
}

function setExplainRunEnabled() {
  const btn = document.getElementById("explainRunBtn");
  const sel = document.getElementById("explainClusterSelect");
  const warn = document.getElementById("explainClusterWarn");
  const prodWarn = document.getElementById("explainProdWarn");
  const confirmCk = document.getElementById("explainConfirmProd");
  const confirmName = document.getElementById("explainConfirmName");
  if (!btn || !sel) return;

  const cluster = getExplainSelectedCluster();
  const hasCluster = !!cluster;
  const hasCommand = !!explainCommandBody && typeof explainCommandBody === "object";
  const hasNs = !!(explainNamespaceResolved && explainNamespaceResolved.includes("."));
  const isProd = isProductionEnv(cluster);

  // Production gate: checkbox AND typed name match required
  const prodConfirmed = !isProd || (
    !!confirmCk && confirmCk.checked
    && !!confirmName && confirmName.value.trim() === cluster.name
  );

  // Truncated source logs override every other state — re-running an incomplete command on a
  // different cluster would explain a different shape from the one that ran in production.
  btn.disabled = explainSourceTruncated || !(hasCluster && hasCommand && hasNs && prodConfirmed);
  if (btn.disabled) {
    if (explainSourceTruncated) btn.title = "Source slow-query log was truncated — run the full query in MongoDB Compass instead";
    else if (!hasCommand) btn.title = "Waiting for the query body to load";
    else if (!hasNs) btn.title = "Query namespace could not be determined";
    else if (!hasCluster) btn.title = "Pick a target cluster first";
    else if (isProd && !prodConfirmed) btn.title = "Confirm the production warning before running";
    else btn.title = "";
  } else {
    btn.title = "";
  }

  // Production cluster: show the strong red warning, hide the soft "pick a cluster" one
  if (prodWarn) prodWarn.hidden = !(hasCluster && hasCommand && hasNs && isProd);

  // Soft "pick a cluster" warning only when the body is ready and no cluster is selected
  if (warn) {
    const shouldWarn = hasCommand && hasNs && !hasCluster;
    warn.hidden = !shouldWarn;
    sel.classList.toggle("is-invalid", shouldWarn);
  }

  // Update the Run button label so users know whether the click will execute or not
  if (cluster) {
    const verbosityEl = document.getElementById("explainVerbosity");
    const v = verbosityEl?.value || "executionStats";
    btn.textContent = `Run explain("${v}")`;
  }
}

function populateExplainClusterSelect() {
  const sel = document.getElementById("explainClusterSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Select cluster…</option>';
  for (const c of clusters) {
    const opt = document.createElement("option");
    opt.value = c._id;
    opt.textContent = clusterDisplayName(clusters, c);
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function openExplainModal(ctx) {
  const modal = document.getElementById("explainModal");
  if (!modal) return;
  explainCurrent = {
    appName: ctx?.appName || "",
    comment: ctx?.comment || "",
    namespace: ctx?.namespace || "",
  };
  explainCommandBody = null;
  explainNamespaceResolved = ctx?.namespace || null;
  explainSourceTruncated = false;

  document.getElementById("explainAppName").textContent = explainCurrent.appName || "(no appName)";
  document.getElementById("explainComment").textContent = explainCurrent.comment || "(no comment)";
  document.getElementById("explainNamespace").textContent = explainCurrent.namespace || "—";
  document.getElementById("explainTimestamp").textContent = "—";
  document.getElementById("explainDuration").textContent = "—";
  document.getElementById("explainPlan").textContent = "—";
  document.getElementById("explainQueryPre").textContent = "Loading…";

  // Reset result panel each time the modal opens.
  document.getElementById("explainResultWrap").hidden = true;
  document.getElementById("explainResultPre").textContent = "";
  document.getElementById("explainResultSummary").innerHTML = "";
  document.getElementById("explainProgress").hidden = true;
  document.getElementById("explainError").hidden = true;
  document.getElementById("explainError").textContent = "";
  const warn = document.getElementById("explainClusterWarn");
  if (warn) warn.hidden = true;
  const truncWarn = document.getElementById("explainTruncatedWarn");
  if (truncWarn) truncWarn.hidden = true;
  const prodWarn = document.getElementById("explainProdWarn");
  if (prodWarn) prodWarn.hidden = true;
  const confirmCk = document.getElementById("explainConfirmProd");
  if (confirmCk) confirmCk.checked = false;
  const confirmName = document.getElementById("explainConfirmName");
  if (confirmName) confirmName.value = "";
  const selReset = document.getElementById("explainClusterSelect");
  if (selReset) selReset.classList.remove("is-invalid");

  populateExplainClusterSelect();
  setExplainRunEnabled();

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  loadExplainQueryBody();
}

function closeExplainModal() {
  const modal = document.getElementById("explainModal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  explainCurrent = null;
}

/**
 * Detect MongoDB log truncation in a slow-query sample doc. Returns true when either:
 *  - the log carried a structured `truncated` object / a legacy boolean true, or
 *  - any captured `command` / `originatingCommand` value contains the `$truncated` placeholder
 *    that mongod inserts when an attribute exceeds `maxLogSizeKB`.
 *  See https://www.mongodb.com/docs/manual/reference/log-messages/
 */
function isSlowQueryLogTruncated(doc) {
  if (!doc || typeof doc !== "object") return false;
  const t = doc.truncated;
  if (t === true) return true;
  if (t && typeof t === "object" && Object.keys(t).length > 0) return true;
  return commandContainsTruncationMarker(doc.command) || commandContainsTruncationMarker(doc.originatingCommand);
}

/** Recursively look for a `$truncated` key (any depth) — that's how mongod marks elided values. */
function commandContainsTruncationMarker(node, depth = 0) {
  if (depth > 8 || node == null) return false;
  if (Array.isArray(node)) return node.some((v) => commandContainsTruncationMarker(v, depth + 1));
  if (typeof node !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(node, "$truncated")) return true;
  for (const v of Object.values(node)) {
    if (commandContainsTruncationMarker(v, depth + 1)) return true;
  }
  return false;
}

async function loadExplainQueryBody() {
  const pre = document.getElementById("explainQueryPre");
  if (!pre || !explainCurrent) return;

  const params = new URLSearchParams();
  // Reuse the dashboard's current time window so we find a sample from roughly the same period.
  const range = getTimeRange();
  if (range) {
    const since = new Date(Date.now() - parseInt(range)).toISOString();
    params.set("since", since);
  }
  if (explainCurrent.appName !== undefined) params.set("appName", explainCurrent.appName);
  if (explainCurrent.comment !== undefined) params.set("comment", explainCurrent.comment);
  if (explainCurrent.namespace) params.set("namespace", explainCurrent.namespace);
  for (const h of getSelectedHosts()) params.append("host", h);
  const dashCid = getDashboardClusterId();
  if (dashCid) params.set("clusterId", dashCid);

  try {
    const res = await fetch(`${API}/api/metrics/slow-query-sample?${params}`);
    if (res.status === 404) {
      pre.textContent = "No matching slow-query log found in the current time range.\nTry widening the time range (All) or relaxing the host filter.";
      return;
    }
    if (!res.ok) {
      pre.textContent = `Failed to load query body (HTTP ${res.status}).`;
      return;
    }
    const doc = await res.json();

    if (doc.timestamp) {
      try { document.getElementById("explainTimestamp").textContent = new Date(doc.timestamp).toLocaleString(); }
      catch { /* ignore */ }
    }
    if (doc.millis != null) document.getElementById("explainDuration").textContent = `${doc.millis} ms`;
    if (doc.planSummary) document.getElementById("explainPlan").textContent = doc.planSummary;
    if (doc.namespace) {
      document.getElementById("explainNamespace").textContent = doc.namespace;
      explainNamespaceResolved = doc.namespace;
    }

    let body = null;
    if (doc.command && typeof doc.command === "object") body = doc.command;
    else if (doc.originatingCommand && typeof doc.originatingCommand === "object") body = doc.originatingCommand;
    else if (typeof doc.raw === "string" && doc.raw.length) {
      try {
        const parsed = JSON.parse(doc.raw);
        body = parsed.attr?.command || null;
      } catch { /* ignore */ }
    }

    if (body) {
      explainCommandBody = body;
      pre.textContent = JSON.stringify(body, null, 2);
    } else {
      explainCommandBody = null;
      pre.textContent = typeof doc.raw === "string" && doc.raw.length
        ? doc.raw
        : "(No command body captured on this slow-query log line.)";
    }

    explainSourceTruncated = isSlowQueryLogTruncated(doc);
    const truncWarn = document.getElementById("explainTruncatedWarn");
    if (truncWarn) truncWarn.hidden = !explainSourceTruncated;

    setExplainRunEnabled();
  } catch (err) {
    pre.textContent = `Network error: ${err.message || err}`;
    explainCommandBody = null;
    explainSourceTruncated = false;
    const truncWarn = document.getElementById("explainTruncatedWarn");
    if (truncWarn) truncWarn.hidden = true;
    setExplainRunEnabled();
  }
}

async function runExplainOnSelectedCluster() {
  const sel = document.getElementById("explainClusterSelect");
  const runBtn = document.getElementById("explainRunBtn");
  const progress = document.getElementById("explainProgress");
  const errBox = document.getElementById("explainError");
  const resultWrap = document.getElementById("explainResultWrap");
  const resultPre = document.getElementById("explainResultPre");
  const resultSummary = document.getElementById("explainResultSummary");

  const clusterId = sel?.value;
  if (!clusterId || !explainCommandBody || !explainNamespaceResolved) return;

  const cluster = getExplainSelectedCluster();
  const isProd = isProductionEnv(cluster);
  // For production targets, the server clamps the timeout to 60s anyway — make the UI cap match.
  const verbosity = document.getElementById("explainVerbosity")?.value || "executionStats";
  const timeoutRaw = Number(document.getElementById("explainTimeoutSec")?.value || 120);
  const timeoutCapSec = isProd ? 60 : 600;
  const timeoutSec = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(Math.max(timeoutRaw, 5), timeoutCapSec)
    : Math.min(120, timeoutCapSec);

  errBox.hidden = true;
  errBox.textContent = "";
  resultWrap.hidden = true;
  resultPre.textContent = "";
  resultPre.hidden = true;
  resultSummary.innerHTML = "";
  // Reset the top-5 stage table + stage-detail + full-plan toggle so stale content doesn't flash.
  const stagesTbody = document.getElementById("explainStagesTbody");
  const stagesTable = document.getElementById("explainStagesTable");
  const stagesEmpty = document.getElementById("explainStagesEmpty");
  const stageDetail = document.getElementById("explainStageDetail");
  const toggleFullBtn = document.getElementById("explainToggleFullBtn");
  if (stagesTbody) stagesTbody.innerHTML = "";
  if (stagesTable) stagesTable.hidden = true;
  if (stagesEmpty) stagesEmpty.hidden = true;
  if (stageDetail) stageDetail.hidden = true;
  if (toggleFullBtn) {
    toggleFullBtn.textContent = "Show full plan JSON";
    toggleFullBtn.setAttribute("aria-expanded", "false");
  }
  // Update the progress banner with the actually-running verbosity for clarity.
  const progressLabel = progress.querySelector("span");
  if (progressLabel) {
    progressLabel.innerHTML = `Running <code>explain("${escHtml(verbosity)}")</code> against the selected cluster (timeout ${timeoutSec}s)…`;
  }
  progress.hidden = false;
  runBtn.disabled = true;

  const started = Date.now();
  try {
    const reqBody = {
      namespace: explainNamespaceResolved,
      command: explainCommandBody,
      verbosity,
      timeoutMs: timeoutSec * 1000,
    };
    if (isProd && cluster) {
      reqBody.confirmProduction = true;
      reqBody.confirmClusterName = cluster.name;
    }
    const res = await fetch(`${API}/api/clusters/${clusterId}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      // If we timed out on an execution-mode explain, point the user at the zero-cost
      // alternative so they can still see the plan shape without waiting or grinding the cluster.
      const isTimeout = /time limit|MaxTimeMS|timed out/i.test(msg);
      let hint = "";
      if (isTimeout && verbosity !== "queryPlanner") {
        hint =
          "\n\nThe server ran the query for the full timeout before giving up. " +
          "Switch Verbosity to queryPlanner to see the plan without executing, " +
          "or raise Timeout and try again.";
      }
      errBox.textContent = `Explain failed: ${msg}${hint}`;
      errBox.hidden = false;
      return;
    }

    const result = data?.result || {};
    resultPre.textContent = JSON.stringify(result, null, 2);
    resultSummary.innerHTML = formatExplainSummary(result, data.elapsedMs ?? (Date.now() - started));
    renderExplainStages(result);
    resultWrap.hidden = false;
    // Pull the result into view.
    resultWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    errBox.textContent = `Network error: ${err.message || err}`;
    errBox.hidden = false;
  } finally {
    progress.hidden = true;
    setExplainRunEnabled();
  }
}

/** Pull the interesting numbers out of an explain result (any verbosity). */
function formatExplainSummary(result, elapsedMs) {
  const stats = result?.executionStats;
  // Aggregation explains wrap queryPlanner under stages[0].$cursor.queryPlanner —
  // fall back to that shape so the summary isn't blank for pipelines.
  const qp =
    result?.queryPlanner ||
    result?.stages?.[0]?.$cursor?.queryPlanner ||
    {};
  const winning = qp.winningPlan || {};

  // Walk inputStage chain to surface the inner-most stage name (past SINGLE_SHARD, PROJECTION, etc.).
  let stage = winning.stage || "—";
  let cur = winning;
  while (cur?.inputStage) {
    cur = cur.inputStage;
    if (cur.stage) stage = cur.stage;
  }

  // Classify: COLLSCAN is bad; IXSCAN with docs≈keys is efficient; docs>>keys is inefficient.
  let cls = "ok";
  if (String(stage).toUpperCase().includes("COLLSCAN")) cls = "bad";

  if (!stats) {
    // queryPlanner verbosity: no execution numbers available.
    return `<span class="${cls}">${escHtml(String(stage))}</span> · plan only (wall ${elapsedMs} ms)`;
  }

  const nReturned = stats.nReturned ?? "—";
  const docs = stats.totalDocsExamined ?? "—";
  const keys = stats.totalKeysExamined ?? "—";
  const ms = stats.executionTimeMillis ?? "—";
  if (cls === "ok" && Number(docs) > 0 && Number(keys) > 0 && Number(docs) / Number(keys) > 10) cls = "warn";

  return `<span class="${cls}">${escHtml(String(stage))}</span> · nReturned=${nReturned} · docs=${docs} · keys=${keys} · ${ms} ms (wall ${elapsedMs} ms)`;
}

// ─── Explain: per-stage table ──────────────────────────────────────────
//
// The full explain document is huge (pipelines nest queryPlanner → executionStages → inputStage
// recursively, and every sub-document has its own counters). Users almost always want to start
// with "which stages are slow?" — so we collect every node that carries an
// `executionTimeMillisEstimate`, show the top-5 in a table, and expose the raw JSON on demand.

/**
 * `executionTimeMillisEstimate` is *cumulative* in MongoDB's explain output:
 *   - in an aggregation pipeline, stage[i] includes the time of every earlier stage
 *     (plus stage[0] which is usually `$cursor` and itself wraps the whole find-stage tree),
 *   - inside a find-stage tree, each parent includes the time of its children.
 *
 * To get the time actually spent *in* that stage we subtract the time already accounted for
 * below/before it. We keep the raw cumulative value on the row too so the user can still
 * cross-reference with the raw JSON ("cumulative" column / detail view).
 *
 * Each collected stage is `{ n, label, ms, cumulativeMs, nReturned, detail }`.
 */
function collectExplainStages(result) {
  const out = [];
  let counter = 0;

  const pipelineStages = Array.isArray(result?.stages) ? result.stages : null;

  if (pipelineStages) {
    // Track the largest cumulative value seen so far: the next pipeline stage can never have
    // run faster than the previous, so we compute self = current - prevCumulative.
    // (Note: stage[0] is typically `$cursor`, whose cumulative time already covers the whole
    // find-stage tree — which is why the tree rows below correctly subtract their own children.)
    let prevCumulative = 0;

    for (const stage of pipelineStages) {
      if (!stage || typeof stage !== "object") continue;
      const opKey = Object.keys(stage).find((k) => k.startsWith("$")) || "(stage)";
      const cumulative = stage.executionTimeMillisEstimate;

      if (cumulative != null) {
        const selfMs = Math.max(0, Number(cumulative) - prevCumulative);
        out.push({
          n: ++counter,
          label: opKey,
          ms: selfMs,
          cumulativeMs: Number(cumulative) || 0,
          nReturned: stage.nReturned,
          detail: stage,
        });
        prevCumulative = Number(cumulative) || prevCumulative;
      }

      // Dive into $cursor to also surface the find-stage tree with per-node self times.
      if (opKey === "$cursor" && stage.$cursor?.executionStats?.executionStages) {
        walkExecTree(stage.$cursor.executionStats.executionStages, out, () => ++counter, "$cursor ▸ ");
      }
    }
  }

  // Plain find/count/distinct: the tree lives directly under executionStats.executionStages.
  if (!pipelineStages && result?.executionStats?.executionStages) {
    walkExecTree(result.executionStats.executionStages, out, () => ++counter, "");
  }

  return out;
}

/**
 * Recursively walk `executionStages`. Each node's `executionTimeMillisEstimate` includes its
 * children, so the "self" time for this stage is `node.ms - sum(direct children ms)`.
 */
function walkExecTree(node, out, nextN, prefix) {
  if (!node || typeof node !== "object") return;
  const cumulative = node.executionTimeMillisEstimate;
  const stageName = node.stage || "(stage)";

  const children = [];
  if (node.inputStage) children.push(node.inputStage);
  if (Array.isArray(node.inputStages)) children.push(...node.inputStages);

  const childrenCumulativeSum = children.reduce((acc, c) => {
    const v = c && typeof c === "object" ? Number(c.executionTimeMillisEstimate) : 0;
    return acc + (Number.isFinite(v) ? v : 0);
  }, 0);

  if (cumulative != null) {
    const selfMs = Math.max(0, Number(cumulative) - childrenCumulativeSum);
    out.push({
      n: nextN(),
      label: `${prefix}${stageName}`,
      ms: selfMs,
      cumulativeMs: Number(cumulative) || 0,
      nReturned: node.nReturned,
      detail: node,
    });
  }

  for (const c of children) walkExecTree(c, out, nextN, prefix);
}

let explainStagesCache = [];
let explainSelectedStageIdx = -1;

function renderExplainStages(result) {
  const tbody = document.getElementById("explainStagesTbody");
  const table = document.getElementById("explainStagesTable");
  const empty = document.getElementById("explainStagesEmpty");
  const detailWrap = document.getElementById("explainStageDetail");
  if (!tbody || !table || !empty || !detailWrap) return;

  tbody.innerHTML = "";
  detailWrap.hidden = true;
  explainStagesCache = collectExplainStages(result);
  explainSelectedStageIdx = -1;

  if (explainStagesCache.length === 0) {
    table.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Sort by self-time desc (the true per-stage cost), keep the top 5. Preserve original
  // stage numbers so the user can map back to the raw pipeline position.
  const top = [...explainStagesCache].sort((a, b) => b.ms - a.ms).slice(0, 5);
  const maxMs = top[0].ms || 1;

  for (const s of top) {
    const tr = document.createElement("tr");
    tr.dataset.stageN = String(s.n);
    const barPct = Math.max(2, Math.round((s.ms / maxMs) * 100));
    const barCls = s.ms >= maxMs * 0.8 ? "bad" : s.ms >= maxMs * 0.4 ? "warn" : "";
    tr.innerHTML = `
      <td class="esc-num">#${s.n}</td>
      <td class="esc-label">${escHtml(s.label)}</td>
      <td class="esc-ms">
        <span class="ms-bar ${barCls}" style="width:${barPct}px"></span>${s.ms} ms
      </td>
      <td class="esc-ms">${s.cumulativeMs} ms</td>
      <td class="esc-rows">${s.nReturned ?? "—"}</td>
    `;
    tr.addEventListener("click", () => selectExplainStage(s.n));
    tbody.appendChild(tr);
  }
  table.hidden = false;

  // Auto-select the slowest one so the user sees a detail payload immediately.
  selectExplainStage(top[0].n);
}

function selectExplainStage(n) {
  const stage = explainStagesCache.find((s) => s.n === n);
  if (!stage) return;
  explainSelectedStageIdx = n;

  const tbody = document.getElementById("explainStagesTbody");
  if (tbody) {
    for (const tr of tbody.querySelectorAll("tr")) {
      tr.classList.toggle("is-selected", tr.dataset.stageN === String(n));
    }
  }

  const label = document.getElementById("explainStageDetailLabel");
  const pre = document.getElementById("explainStageDetailPre");
  const wrap = document.getElementById("explainStageDetail");
  if (label) label.textContent = `#${stage.n} ${stage.label} — self ${stage.ms} ms / cumulative ${stage.cumulativeMs} ms`;
  if (pre) pre.textContent = JSON.stringify(stage.detail, null, 2);
  if (wrap) wrap.hidden = false;
}

document.getElementById("explainModalClose")?.addEventListener("click", closeExplainModal);
document.getElementById("explainCloseFooterBtn")?.addEventListener("click", closeExplainModal);
document.getElementById("explainModal")?.addEventListener("click", (e) => {
  // Click on the overlay (not the dialog) closes the modal.
  if (e.target.id === "explainModal") closeExplainModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("explainModal");
    if (modal && !modal.hidden) closeExplainModal();
  }
});
document.getElementById("explainCopyBtn")?.addEventListener("click", async () => {
  const pre = document.getElementById("explainQueryPre");
  if (!pre) return;
  try { await navigator.clipboard.writeText(pre.textContent || ""); } catch { /* ignore */ }
});
document.getElementById("explainResultCopyBtn")?.addEventListener("click", async () => {
  const pre = document.getElementById("explainResultPre");
  if (!pre) return;
  try { await navigator.clipboard.writeText(pre.textContent || ""); } catch { /* ignore */ }
});
document.getElementById("explainStageCopyBtn")?.addEventListener("click", async () => {
  const pre = document.getElementById("explainStageDetailPre");
  if (!pre) return;
  try { await navigator.clipboard.writeText(pre.textContent || ""); } catch { /* ignore */ }
});
document.getElementById("explainToggleFullBtn")?.addEventListener("click", () => {
  const btn = document.getElementById("explainToggleFullBtn");
  const pre = document.getElementById("explainResultPre");
  if (!btn || !pre) return;
  const willShow = pre.hidden;
  pre.hidden = !willShow;
  btn.setAttribute("aria-expanded", String(willShow));
  btn.textContent = willShow ? "Hide full plan JSON" : "Show full plan JSON";
});
document.getElementById("explainClusterSelect")?.addEventListener("change", () => {
  // When the user picks a production cluster, default verbosity to queryPlanner (no execution),
  // tighten the timeout cap to 60s, and prefill the typed-confirmation field for convenience.
  const cluster = getExplainSelectedCluster();
  if (isProductionEnv(cluster)) {
    const v = document.getElementById("explainVerbosity");
    if (v && v.value !== "queryPlanner") v.value = "queryPlanner";
    const timeoutEl = document.getElementById("explainTimeoutSec");
    if (timeoutEl) {
      timeoutEl.max = "60";
      if (Number(timeoutEl.value) > 60) timeoutEl.value = "60";
    }
    // Reset confirm fields whenever the target changes so the user has to re-confirm
    const confirmCk = document.getElementById("explainConfirmProd");
    if (confirmCk) confirmCk.checked = false;
    const confirmName = document.getElementById("explainConfirmName");
    if (confirmName) confirmName.value = "";
  } else {
    const timeoutEl = document.getElementById("explainTimeoutSec");
    if (timeoutEl) timeoutEl.max = "600";
  }
  setExplainRunEnabled();
});
document.getElementById("explainVerbosity")?.addEventListener("change", setExplainRunEnabled);
document.getElementById("explainConfirmProd")?.addEventListener("change", setExplainRunEnabled);
document.getElementById("explainConfirmName")?.addEventListener("input", setExplainRunEnabled);
document.getElementById("explainRunBtn")?.addEventListener("click", runExplainOnSelectedCluster);

document.getElementById("dashboardClusterSelect")?.addEventListener("change", () => {
  const sel = document.getElementById("dashboardClusterSelect");
  if (sel?.value) localStorage.setItem(DASH_CLUSTER_LS, String(sel.value));
  loadDatabases({ resetAll: true });
  loadHosts({ resetAll: true });
  loadMetrics();
  loadDiskUsage();
  loadOplogWindow();
  loadStorageStats();
});

// ─── Init ───────────────────────────────────────────────────────────
checkHealth();
(async function initDashboard() {
  await loadClusters();
  await Promise.all([loadDatabases(), loadHosts()]);
  loadMetrics();
  loadDiskUsage();
  loadOplogWindow();
  loadStorageStats();
})();

setInterval(async () => {
  checkHealth();
  await loadClusters();
  await Promise.all([loadDatabases(), loadHosts()]);
  loadMetrics();
  loadDiskUsage();
  loadOplogWindow();
}, 60_000);

setInterval(loadStorageStats, 600_000);
