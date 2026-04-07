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
let queryStatsTimelineChart = null;
let treemapIOChart = null;
let treemapCPUChart = null;

function shortName(name, max) {
  if (!name) return "(no appName)";
  return name.length > max ? name.slice(0, max - 2) + "…" : name;
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
async function checkHealth() {
  const badge = document.getElementById("mongoStatus");
  const dot = document.getElementById("statusDot");
  try {
    const res = await fetch(`${API}/api/health`);
    const data = await res.json();
    if (data.status === "ok") {
      badge.textContent = "Connected";
      badge.className = "badge ok";
      dot.style.background = "#00ed64";
    } else throw new Error();
  } catch {
    badge.textContent = "Disconnected";
    badge.className = "badge err";
    dot.style.background = "#ff5050";
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

function renderTopology(clusterId) {
  const t = topologyMap[clusterId];
  if (!t || !t.hosts.length)
    return '<div class="topology"><span class="topo-label">No topology discovered yet</span></div>';
  const members = t.hosts
    .map((h) => `<span class="topo-member${h === t.primary ? " primary" : ""}">${h}${h === t.primary ? " (P)" : ""}</span>`)
    .join("");
  return `<div class="topology">
    <div class="topo-label">Replica set: ${t.setName || "unknown"} <button class="btn-discover" onclick="rediscover('${clusterId}')">Refresh</button></div>
    <div class="topo-members">${members}</div>
  </div>`;
}

// ─── Filters ────────────────────────────────────────────────────────

const HIDDEN_DBS = ["admin", "config", "local", "mongomonitor"];
let allNamespaces = [];
let visibleNamespaces = [];
let allHosts = [];

function isHiddenNs(ns) {
  return HIDDEN_DBS.includes(ns.split(".")[0]);
}

function getChecked(selector) {
  const boxes = document.querySelectorAll(`${selector} input[type=checkbox]`);
  return [...boxes].filter((b) => b.checked).map((b) => b.value);
}

function getSelectedNamespaces() { return getChecked("#nsFilter"); }
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
  for (const ns of getSelectedNamespaces()) params.append("namespace", ns);
  for (const h of getSelectedHosts()) params.append("host", h);
  const range = getTimeRange();
  if (range) {
    const since = new Date(Date.now() - parseInt(range)).toISOString();
    params.set("since", since);
  }
  return params;
}

function shortHost(h) {
  return h.replace(/\.mongodb\.net:\d+$/, "").replace(/\.ljwx2$/, "");
}

async function loadHosts() {
  try {
    const res = await fetch(`${API}/api/metrics/hosts`);
    allHosts = await res.json();
    const container = document.getElementById("hostFilter");
    const prev = getSelectedHosts();
    const isFirst = container.children.length === 0;

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

async function loadNamespaces() {
  try {
    const res = await fetch(`${API}/api/metrics/namespaces`);
    allNamespaces = await res.json();
    visibleNamespaces = allNamespaces.filter((ns) => !isHiddenNs(ns));
    const container = document.getElementById("nsFilter");
    const prev = getSelectedNamespaces();
    const isFirst = container.children.length === 0;

    container.innerHTML = visibleNamespaces.map((ns) => {
      const checked = isFirst ? true : prev.includes(ns);
      return `<label class="ns-cb">
        <input type="checkbox" value="${ns}"${checked ? " checked" : ""}> ${ns}
      </label>`;
    }).join("");

    container.querySelectorAll("input").forEach((cb) => {
      cb.addEventListener("change", () => loadMetrics());
    });
  } catch { /* ignore */ }
}

function nsSelectAll() {
  document.querySelectorAll("#nsFilter input").forEach((cb) => { cb.checked = true; });
  loadMetrics();
}
function nsSelectNone() {
  document.querySelectorAll("#nsFilter input").forEach((cb) => { cb.checked = false; });
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

async function loadMetrics() {
  if (!getSelectedNamespaces().length || !getSelectedHosts().length) {
    destroyCharts([appLoadExecChart, appLoadTimeChart, slowestAppChart, queryStatsTimelineChart, treemapIOChart, treemapCPUChart]);
    appLoadExecChart = appLoadTimeChart = slowestAppChart = queryStatsTimelineChart = treemapIOChart = treemapCPUChart = null;
    const sq = document.getElementById("slowQuerySection");
    if (sq) sq.style.display = "none";
    return;
  }
  await loadAppLoad();
  await loadQueryStatsTimeline();
  await loadImpactChart();
  await loadSlowQueries();
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

    const labels = data.map((d) => shortName(d.appName, 35));
    const execCounts = data.map((d) => d.totalExecCount);
    const execMs = data.map((d) => Math.round(d.totalExecMicros / 1000));

    appLoadExecChart = rebuildChart(appLoadExecChart, "appLoadExecChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Exec Count", data: execCounts, backgroundColor: CHART_COLORS.slice(0, labels.length), borderRadius: 4, maxBarThickness: 40 }],
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

    appLoadTimeChart = rebuildChart(appLoadTimeChart, "appLoadTimeChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Total Time (ms)", data: execMs, backgroundColor: CHART_COLORS.slice(0, labels.length), borderRadius: 4, maxBarThickness: 40 }],
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

    const avgMs = data.map((d) => d.totalExecCount > 0 ? Math.round(d.totalExecMicros / d.totalExecCount / 1000) : 0);
    const sorted = labels.map((l, i) => ({ label: l, val: avgMs[i] })).sort((a, b) => b.val - a.val);

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

// ─── Query Stats Timeline ───────────────────────────────────────────

async function loadQueryStatsTimeline() {
  try {
    const p = metricsParams();
    const res = await fetch(`${API}/api/metrics/query-stats?${p}`);
    const data = await res.json();
    if (!data.length) { destroyCharts([queryStatsTimelineChart]); return; }

    const byShape = {};
    for (const d of data) {
      const key = d.queryShapeHash;
      if (!byShape[key]) byShape[key] = [];
      byShape[key].push(d);
    }

    const deltasByTime = {};
    for (const entries of Object.values(byShape)) {
      entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (let i = 1; i < entries.length; i++) {
        const ts = entries[i].timestamp;
        const dExec = Math.max(0, entries[i].execCount - entries[i - 1].execCount);
        const dDocs = Math.max(0, entries[i].docsExamined - entries[i - 1].docsExamined);
        if (!deltasByTime[ts]) deltasByTime[ts] = { exec: 0, docs: 0 };
        deltasByTime[ts].exec += dExec;
        deltasByTime[ts].docs += dDocs;
      }
    }

    const times = Object.keys(deltasByTime).sort();
    if (!times.length) { destroyCharts([queryStatsTimelineChart]); return; }
    const labels = times.map((t) => new Date(t).toLocaleTimeString());

    queryStatsTimelineChart = rebuildChart(queryStatsTimelineChart, "queryStatsTimeline", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "New Executions", data: times.map((t) => deltasByTime[t].exec), backgroundColor: "rgba(0,237,100,0.6)", borderRadius: 3, yAxisID: "y", order: 2 },
          { label: "New Docs Examined", data: times.map((t) => deltasByTime[t].docs), type: "line", borderColor: "#00a3ff", backgroundColor: "rgba(0,163,255,0.08)", fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2, yAxisID: "y1", order: 1 },
        ],
      },
      options: {
        ...chartDefaults,
        scales: {
          x: { ticks: { color: "#5c6d7e", font: { size: 9 } }, grid: { color: "#1e3a4f22" } },
          y: { type: "linear", position: "left", ticks: { color: "#00ed64" }, grid: { color: "#1e3a4f" }, beginAtZero: true, title: { display: true, text: "New Executions", color: "#00ed64" } },
          y1: { type: "linear", position: "right", ticks: { color: "#00a3ff" }, grid: { display: false }, beginAtZero: true, title: { display: true, text: "New Docs Examined", color: "#00a3ff" } },
        },
      },
    });
  } catch { /* ignore */ }
}

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
        groups: ["appName"],
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
          callbacks: {
            title: (items) => {
              const d = items[0]?.raw?._data;
              if (!d) return items[0]?.raw?.g || "";
              if (d.queryLabel) return `${d.appName} — ${d.queryLabel}`;
              return d.appName || "";
            },
            label: (ctx) => {
              const d = ctx.raw?._data;
              if (!d || !d.queryLabel) return `Slow queries: ${ctx.raw?.v || 0}`;
              return tooltipFn(d);
            },
          },
          titleFont: { weight: "bold", size: 13 },
          bodyFont: { size: 11 },
          padding: 10,
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

    const maxBytes = Math.max(...data.map((d) => d.totalBytesRead), 1);
    const maxCpu = Math.max(...data.map((d) => d.totalCpuNanos), 1);

    const treeData = data.map((d) => {
      const app = d.appName || "(no appName)";
      const comment = d.comment || "(no comment)";
      const shortComment = comment.length > 40 ? comment.slice(0, 38) + "…" : comment;
      const ns = (d.namespaces || []).filter(Boolean).join(", ") || "—";
      return {
        appName: app,
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

async function loadSlowQueries() {
  const section = document.getElementById("slowQuerySection");
  const container = document.getElementById("slowQueryList");
  try {
    const res = await fetch(`${API}/api/metrics/slow-queries?${metricsParams()}`);
    const data = await res.json();
    if (!data.length) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    container.innerHTML = data.slice(0, 50).map((sq) => `
      <div class="slow-query-item">
        <div class="sq-header">
          <span class="sq-app">${sq.appName || "unknown"}</span>
          <span class="sq-millis">${sq.millis}ms</span>
          <span class="sq-time">${new Date(sq.timestamp).toLocaleString()}</span>
        </div>
        <div class="sq-details">
          <span>ns: ${sq.namespace || "—"}</span>
          <span>plan: ${sq.planSummary || "—"}</span>
          <span>docs: ${sq.docsExamined}</span>
          <span>keys: ${sq.keysExamined}</span>
          ${sq.cpuNanos ? `<span>cpu: ${(sq.cpuNanos / 1e6).toFixed(1)}ms</span>` : ""}
          ${sq.bytesRead ? `<span>read: ${(sq.bytesRead / 1024).toFixed(1)}KB</span>` : ""}
        </div>
        ${sq.comment ? `<div class="sq-comment">comment: ${sq.comment}</div>` : ""}
      </div>
    `).join("");
  } catch {
    section.style.display = "none";
  }
}

// ─── Clusters ───────────────────────────────────────────────────────

async function loadClusters() {
  const list = document.getElementById("clusterList");
  try {
    await loadTopologies();
    const res = await fetch(`${API}/api/clusters`);
    clusters = await res.json();
    if (!clusters.length) {
      list.innerHTML = '<li class="empty">No clusters registered yet.</li>';
      return;
    }
    list.innerHTML = clusters
      .map((c) => `
      <li>
        <div class="cluster-header">
          <div>
            <span class="cluster-name">${c.name}</span>
            <span class="cluster-meta"> — ${c.region}</span>
            ${c.atlasProjectId ? `<a class="atlas-link" href="https://cloud.mongodb.com/v2/${c.atlasProjectId}#/clusters/detail/${c.name}" target="_blank">Atlas Console</a>` : ""}
          </div>
          <button class="btn btn-sm" onclick="removeCluster('${c._id}')">Remove</button>
        </div>
        ${renderTopology(c._id)}
      </li>`)
      .join("");
  } catch {
    list.innerHTML = '<li class="empty">Failed to load clusters.</li>';
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
  await fetch(`${API}/api/clusters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: form.get("name"),
      uri: form.get("uri"),
      region: form.get("region"),
      atlasProjectId: form.get("atlasProjectId") || undefined,
      atlasPublicKey: form.get("atlasPublicKey") || undefined,
      atlasPrivateKey: form.get("atlasPrivateKey") || undefined,
    }),
  });
  e.target.reset();
  loadClusters();
});

async function removeCluster(id) {
  await fetch(`${API}/api/clusters/${id}`, { method: "DELETE" });
  loadClusters();
}

// ─── Init ───────────────────────────────────────────────────────────
checkHealth();
loadClusters();
Promise.all([loadNamespaces(), loadHosts()]).then(() => loadMetrics());

setInterval(() => {
  loadNamespaces();
  loadHosts();
  loadMetrics();
  loadClusters();
}, 60_000);
