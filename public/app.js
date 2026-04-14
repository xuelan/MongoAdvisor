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

// Keep in sync with src/hidden-dbs.js (HIDDEN_TOP_LEVEL_DBS)
const HIDDEN_DBS = ["admin", "config", "local", "mongoadvisor", "mongomonitor", "#mongodb-mcp"];
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

/** Index list APIs: host filter only. Do not pass namespace — $queryStats namespaces omit collections with no recent traffic but indexes still exist there. */
function indexListParams() {
  const params = new URLSearchParams();
  for (const h of getSelectedHosts()) params.append("host", h);
  const q = params.toString();
  return q ? `?${q}` : "";
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
    destroyCharts([appLoadExecChart, appLoadTimeChart, slowestAppChart, bubbleChart, treemapIOChart, treemapCPUChart]);
    appLoadExecChart = appLoadTimeChart = slowestAppChart = bubbleChart = treemapIOChart = treemapCPUChart = null;
  } else {
    await loadAppLoad();
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
            maxWidth: 500,
            bodyFont: { size: 11 },
            titleFont: { size: 12 },
            callbacks: {
              title(items) {
                const p = items[0]?.raw;
                if (!p) return "";
                const lines = [`App: ${p.appName}`];
                const comment = p.comment || "(no comment)";
                for (let i = 0; i < comment.length; i += 70) {
                  const prefix = i === 0 ? "Comment: " : "  ";
                  lines.push(prefix + comment.slice(i, i + 70));
                }
                return lines;
              },
              label(ctx) {
                const p = ctx.raw;
                const wrap = (prefix, s, w) => {
                  if (!s || s.length <= w) return [`${prefix}${s || "—"}`];
                  const lines = [];
                  for (let i = 0; i < s.length; i += w) {
                    lines.push((i === 0 ? prefix : "  ") + s.slice(i, i + w));
                  }
                  return lines;
                };
                return [
                  `Count: ${p.count}  |  Avg: ${p.avgMillis}ms  |  Max: ${p.maxMillis}ms`,
                  `Total: ${formatNum(p.totalMillis)}ms  |  CPU: ${p.totalCpuMs}ms`,
                  `IO: ${p.totalBytesReadMB} MB  |  Docs: ${formatNum(p.docsExamined)}  |  Keys: ${formatNum(p.keysExamined)}`,
                  ...wrap("NS: ", p.ns, 60),
                  ...wrap("Plan: ", p.plans, 55),
                ];
              },
            },
          },
        },
      },
    });
  } catch (err) {
    console.error("bubble chart error:", err);
  }
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
            const d = tooltip.dataPoints?.[0]?.raw?._data;
            if (!d) { el.style.opacity = "0"; return; }
            const kids = d.children || [d];
            let html = `<div class="tt-title">App: ${d.appName || "—"}</div>`;
            for (const kid of kids) {
              const comment = kid.fullComment || "(no comment)";
              const metrics = tooltipFn(kid);
              html += `<div class="tt-entry">`;
              html += `<div class="tt-comment">${comment}</div>`;
              html += metrics.map((l) => `<div class="tt-metric">${l}</div>`).join("");
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

async function loadUnusedIndexes() {
  const container = document.getElementById("unusedIndexList");
  try {
    const res = await fetch(`${API}/api/metrics/unused-indexes${indexListParams()}`);
    const data = await res.json();
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
    container.innerHTML = '<div class="index-empty">Failed to load</div>';
  }
}

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
    for (const ns of getSelectedNamespaces()) params.append("namespace", ns);
    const res = await fetch(`${API}/api/metrics/storage?${params}`)
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

async function loadClusters() {
  const list = document.getElementById("clusterList");
  try {
    await loadTopologies();
    const res = await fetch(`${API}/api/clusters`);
    clusters = await res.json();
    populateClusterEditSelect();
    if (!clusters.length) {
      list.innerHTML = '<li class="empty">No clusters registered yet.</li>';
      return;
    }
    list.innerHTML = clusters
      .map((c) => {
        const displayName = clusterDisplayName(clusters, c);
        return `
      <li>
        <div class="cluster-header">
          <div>
            <span class="cluster-name">${displayName}</span>
            <span class="cluster-meta"> — ${escAttr(c.region || "")}</span>
            ${c.atlasProjectId ? `<a class="atlas-link" href="https://cloud.mongodb.com/v2/${c.atlasProjectId}#/clusters/detail/${c.name}" target="_blank">Atlas Console</a>` : ""}
          </div>
          <button class="btn btn-sm" onclick="removeCluster('${c._id}')">Remove</button>
        </div>
        ${renderTopology(c._id)}
      </li>`;
      })
      .join("");
  } catch {
    clusters = [];
    populateClusterEditSelect();
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
  try {
    const res = await fetch(`${API}/api/clusters`, {
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
    const errBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      showClusterFormFeedback(errBody.error || `Could not add cluster (${res.status})`, true);
      return;
    }
    e.target.reset();
    showClusterFormFeedback("Cluster registered.", false);
    loadClusters();
  } catch (err) {
    showClusterFormFeedback(err.message || "Network error", true);
  }
});

async function removeCluster(id) {
  await fetch(`${API}/api/clusters/${id}`, { method: "DELETE" });
  loadClusters();
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
    showClusterFormFeedback("Cluster updated.", false);
    loadClusters();
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
    const res = await fetch(`${API}/api/metrics/disk-usage`);
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
    const res = await fetch(`${API}/api/metrics/oplog-window`);
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

// ─── Init ───────────────────────────────────────────────────────────
checkHealth();
loadClusters();
loadDiskUsage();
loadOplogWindow();
loadStorageStats();
Promise.all([loadNamespaces(), loadHosts()]).then(() => loadMetrics());

setInterval(() => {
  checkHealth();
  loadNamespaces();
  loadHosts();
  loadMetrics();
  loadClusters();
  loadDiskUsage();
  loadOplogWindow();
}, 60_000);

setInterval(loadStorageStats, 600_000);
