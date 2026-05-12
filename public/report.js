/**
 * MongoAdvisor — Reports page.
 *
 * Two modes share this file:
 *   1. Live page served from `/report.html`
 *      - No `?id=` → upload + list view, talks to /api/reports.
 *      - With `?id=` → single-report view, fetches /api/reports/:id.
 *   2. Downloaded self-contained file (`*.mongoadvisor.html`)
 *      - The server inlines the report JSON into `<script id="reportData" type="application/json">`
 *        and strips the Chart.js CDN tag. We detect that case, parse the embedded JSON, and
 *        route every chart draw through the inline-SVG fallback renderer below.
 */

(function () {
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get("id");

  const SEVERITY_ORDER = ["HIGH", "MEDIUM", "LOW", "INFO"];
  const SEVERITY_COLORS = {
    HIGH: "#ff5050",
    MEDIUM: "#ffb020",
    LOW: "#8899a6",
    INFO: "#00a3ff",
  };
  const PALETTE = ["#00ed64", "#00a3ff", "#ffb020", "#ff5050", "#6c5ce7", "#ee5a24", "#ffd93d"];

  // ─── small DOM helpers ───
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }
  function fmtBytesMb(mb) {
    if (!mb && mb !== 0) return "—";
    const n = Number(mb);
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " TB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " GB";
    if (n >= 1) return n.toFixed(1) + " MB";
    return (n * 1024).toFixed(0) + " KB";
  }
  function fmtInt(n) {
    if (n == null) return "—";
    return Number(n).toLocaleString();
  }
  function fmtDate(d) {
    if (!d) return "—";
    const t = new Date(d).getTime();
    if (!Number.isFinite(t)) return String(d);
    return new Date(t).toLocaleString();
  }
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    // attrs may legitimately be passed as null (callers use `el("td", null, …)`); a
    // default `= {}` only kicks in for `undefined`, so we normalize here.
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (typeof v === "boolean") {
        if (v) node.setAttribute(k, "");
      } else {
        node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  function severityBadge(sev) {
    const s = (sev || "INFO").toUpperCase();
    return el(
      "span",
      { class: `sev-badge sev-${s.toLowerCase()}` },
      s,
    );
  }
  function topologyBadge(topology) {
    return el("span", { class: "topology-badge" }, String(topology || "—"));
  }

  // ─── inline-SVG chart fallback (offline) ───
  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      node.setAttribute(k, v);
    }
    return node;
  }
  function drawSvgDoughnut(canvas, spec) {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 220;
    const svg = svgEl("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 24, ir = r * 0.55;
    const total = spec.values.reduce((a, b) => a + (b || 0), 0) || 1;
    let angle = -Math.PI / 2;
    spec.values.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2;
      const start = angle, end = angle + slice;
      angle = end;
      if (v === 0) return;
      const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      const x3 = cx + ir * Math.cos(end), y3 = cy + ir * Math.sin(end);
      const x4 = cx + ir * Math.cos(start), y4 = cy + ir * Math.sin(start);
      const large = slice > Math.PI ? 1 : 0;
      const d = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${ir},${ir} 0 ${large} 0 ${x4},${y4} Z`;
      const fill = (spec.colors && spec.colors[i]) || PALETTE[i % PALETTE.length];
      svg.appendChild(svgEl("path", { d, fill }));
    });
    // Center label = total
    const txt = svgEl("text", { x: cx, y: cy + 6, "text-anchor": "middle", fill: "#e0e0e0", "font-size": "1rem", "font-weight": "600" });
    txt.textContent = String(total);
    svg.appendChild(txt);
    // Legend below
    const legend = el("div", { class: "report-chart-legend" });
    spec.labels.forEach((lbl, i) => {
      const sw = el("span", { class: "rcl-sw", style: `background:${(spec.colors && spec.colors[i]) || PALETTE[i % PALETTE.length]}` });
      legend.appendChild(el("span", { class: "rcl-item" }, sw, ` ${lbl} (${spec.values[i] || 0})`));
    });
    const wrap = canvas.parentElement;
    canvas.style.display = "none";
    const out = el("div", { class: "report-chart-fallback" });
    out.appendChild(svg);
    out.appendChild(legend);
    wrap.appendChild(out);
  }
  function drawSvgHBars(canvas, spec) {
    const rowH = 22, gap = 6;
    const labels = spec.labels.slice(0, spec.maxRows || 20);
    const values = spec.values.slice(0, labels.length);
    const colors = spec.colors || labels.map((_, i) => PALETTE[i % PALETTE.length]);
    const max = Math.max(1, ...values);
    const w = canvas.clientWidth || 480;
    const h = labels.length * (rowH + gap) + 12;
    const labelW = Math.min(220, Math.max(60, w * 0.35));
    // Reserve a value gutter on the right so the longest bar's value label
    // (e.g. "32.9 GB") always fits inside the canvas. Without this, the max bar
    // fills the full bar area and the trailing unit gets clipped at the edge.
    const valueGutter = 72;
    const rightPad = 8;
    const barAreaW = Math.max(40, w - labelW - rightPad - valueGutter);
    const svg = svgEl("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    labels.forEach((lbl, i) => {
      const y = i * (rowH + gap) + 6;
      const lblText = svgEl("text", { x: labelW - 6, y: y + rowH - 6, "text-anchor": "end", fill: "#8899a6", "font-size": "0.72rem" });
      lblText.textContent = lbl.length > 32 ? lbl.slice(0, 31) + "…" : lbl;
      svg.appendChild(lblText);
      const bg = svgEl("rect", { x: labelW, y, width: barAreaW, height: rowH, fill: "#0f1923", rx: 4 });
      svg.appendChild(bg);
      const bw = Math.max(2, (values[i] / max) * barAreaW);
      svg.appendChild(svgEl("rect", { x: labelW, y, width: bw, height: rowH, fill: colors[i] || PALETTE[i % PALETTE.length], rx: 4 }));
      const valueStr = spec.formatValue ? spec.formatValue(values[i]) : String(values[i]);
      // Default: draw the value after the bar (in the gutter). On very narrow viewports
      // where the gutter would still overflow, draw it inside the bar instead, right-
      // aligned, so the text never gets clipped by the SVG edge.
      const naturalX = labelW + bw + 6;
      const maxX = w - rightPad;
      const fitsAfterBar = naturalX + valueGutter - 6 <= maxX;
      const vText = fitsAfterBar
        ? svgEl("text", { x: naturalX, y: y + rowH - 6, fill: "#e0e0e0", "font-size": "0.72rem" })
        : svgEl("text", { x: labelW + bw - 6, y: y + rowH - 6, "text-anchor": "end", fill: "#0a0e13", "font-size": "0.72rem", "font-weight": "600" });
      vText.textContent = valueStr;
      svg.appendChild(vText);
    });
    canvas.style.display = "none";
    const wrap = canvas.parentElement;
    const out = el("div", { class: "report-chart-fallback" });
    out.appendChild(svg);
    wrap.appendChild(out);
  }

  // ─── dual-renderer abstraction ───
  function renderChart(canvas, spec) {
    if (!canvas) return;
    // Online: Chart.js is loaded.
    if (typeof window.Chart !== "undefined") {
      const ctx = canvas.getContext("2d");
      if (spec.kind === "doughnut") {
        return new window.Chart(ctx, {
          type: "doughnut",
          data: {
            labels: spec.labels,
            datasets: [{
              data: spec.values,
              backgroundColor: spec.colors || PALETTE,
              borderColor: "#162330",
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { labels: { color: "#e0e0e0", font: { size: 12 } } },
            },
          },
        });
      }
      if (spec.kind === "hbar") {
        const fmt = spec.formatValue || ((v) => String(v));
        return new window.Chart(ctx, {
          type: "bar",
          data: {
            labels: spec.labels,
            datasets: [{
              data: spec.values,
              backgroundColor: spec.colors || PALETTE,
              borderColor: "#162330",
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${fmt(ctx.parsed.x)}`,
                },
              },
            },
            scales: {
              x: {
                ticks: {
                  color: "#8899a6",
                  callback: (value) => fmt(value),
                },
                grid: { color: "#1e3a4f" },
              },
              y: { ticks: { color: "#8899a6" }, grid: { display: false } },
            },
          },
        });
      }
      if (spec.kind === "stackedBar") {
        const fmt = spec.formatValue || ((v) => String(v));
        return new window.Chart(ctx, {
          type: "bar",
          data: { labels: spec.labels, datasets: spec.datasets },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { labels: { color: "#e0e0e0" } },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.dataset.label || ""}: ${fmt(ctx.parsed.x)}`.trim(),
                },
              },
            },
            scales: {
              x: {
                stacked: true,
                ticks: {
                  color: "#8899a6",
                  callback: (value) => fmt(value),
                },
                grid: { color: "#1e3a4f" },
              },
              y: { stacked: true, ticks: { color: "#8899a6" }, grid: { display: false } },
            },
          },
        });
      }
    }
    // Offline: inline SVG fallback.
    if (spec.kind === "doughnut") return drawSvgDoughnut(canvas, spec);
    if (spec.kind === "hbar") return drawSvgHBars(canvas, spec);
    if (spec.kind === "stackedBar") {
      // Flatten into one bar with sum, color by first dataset — keep offline simple.
      const sum = spec.labels.map((_, i) =>
        spec.datasets.reduce((acc, d) => acc + (d.data[i] || 0), 0),
      );
      return drawSvgHBars(canvas, {
        labels: spec.labels,
        values: sum,
        colors: spec.labels.map(() => spec.datasets[0]?.backgroundColor || PALETTE[0]),
      });
    }
  }

  // ─── data fetchers ───
  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const body = await r.json();
        if (body?.error) msg = body.error;
      } catch (_) { /* keep status */ }
      throw new Error(msg);
    }
    return r.json();
  }

  // ─── LIST view ───
  function renderList(reports) {
    const tbody = $("#reportListBody");
    tbody.innerHTML = "";
    if (!reports || reports.length === 0) {
      show($("#reportListEmpty"));
      return;
    }
    hide($("#reportListEmpty"));
    for (const r of reports) {
      const sev = r.summary?.bySeverity || {};
      const tr = el("tr");
      tr.appendChild(el("td", null, el("a", { href: `/report.html?id=${r._id}`, class: "report-link" }, r.name || "(no name)")));
      tr.appendChild(el("td", null, topologyBadge(r.topology)));
      const findings = el("td");
      ["HIGH", "MEDIUM", "LOW", "INFO"].forEach((s) => {
        if (sev[s]) findings.appendChild(el("span", { class: `sev-pill sev-${s.toLowerCase()}` }, `${sev[s]} ${s[0]}`));
      });
      if (Object.values(sev).every((v) => !v)) findings.appendChild(el("span", { class: "report-muted" }, "none"));
      tr.appendChild(findings);
      tr.appendChild(el("td", null, String(r.summary?.nodeCount || (r.nodes || []).length || "—")));
      tr.appendChild(el("td", null, fmtDate(r.createdAt)));
      const actions = el("td", { class: "report-actions" });
      actions.appendChild(el("a", { href: `/report.html?id=${r._id}`, class: "btn btn-sm btn-action" }, "View"));
      actions.appendChild(el("a", { href: `/api/reports/${r._id}/download.html`, class: "btn btn-sm btn-action" }, "Download"));
      actions.appendChild(el("button", { class: "btn-sm", onClick: () => deleteReport(r._id) }, "Delete"));
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }

  async function deleteReport(id) {
    if (!confirm("Delete this report?")) return;
    try {
      await fetchJSON(`/api/reports/${id}`, { method: "DELETE" });
      loadList();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  let queuedFiles = [];
  function renderQueue() {
    const q = $("#reportFileQueue");
    if (queuedFiles.length === 0) { hide(q); $("#reportGenerateBtn").disabled = true; return; }
    show(q);
    $("#reportGenerateBtn").disabled = false;
    q.innerHTML = "";
    queuedFiles.forEach((f, idx) => {
      const sizeMb = (f.size / 1024 / 1024).toFixed(2);
      const row = el("div", { class: "report-queue-row" },
        el("span", { class: "report-queue-name" }, f.name),
        el("span", { class: "report-queue-size" }, `${sizeMb} MB`),
        el("button", { type: "button", class: "report-queue-x", onClick: () => { queuedFiles.splice(idx, 1); renderQueue(); } }, "×"),
      );
      q.appendChild(row);
    });
  }
  function pushFiles(fileList) {
    for (const f of fileList) queuedFiles.push(f);
    renderQueue();
  }

  function setupUpload() {
    const input = $("#reportFiles");
    const zone = $("#reportDropZone");
    const form = $("#reportUploadForm");
    const feedback = $("#reportUploadFeedback");

    input.addEventListener("change", () => {
      pushFiles(Array.from(input.files || []));
      input.value = "";
    });
    ["dragenter", "dragover"].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("dragover"); }),
    );
    ["dragleave", "drop"].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("dragover"); }),
    );
    zone.addEventListener("drop", (e) => {
      pushFiles(Array.from(e.dataTransfer?.files || []));
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (queuedFiles.length === 0) return;
      const fd = new FormData();
      for (const f of queuedFiles) fd.append("files", f, f.name);
      const name = form.querySelector("input[name=name]").value.trim();
      if (name) fd.append("name", name);
      feedback.className = "cluster-form-feedback";
      feedback.textContent = "Uploading and analyzing…";
      show(feedback);
      $("#reportGenerateBtn").disabled = true;
      try {
        const res = await fetch("/api/reports", { method: "POST", body: fd });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `${res.status} ${res.statusText}`);
        }
        const body = await res.json();
        window.location.href = `/report.html?id=${body.id}`;
      } catch (err) {
        feedback.className = "cluster-form-feedback err";
        feedback.textContent = "Upload failed: " + err.message;
        $("#reportGenerateBtn").disabled = false;
      }
    });
  }

  async function loadList() {
    try {
      const reports = await fetchJSON("/api/reports");
      renderList(reports);
    } catch (err) {
      $("#reportListBody").innerHTML = "";
      const e = $("#reportError");
      e.textContent = "Could not load reports: " + err.message;
      show(e);
    }
  }

  // ─── SINGLE view ───
  function buildSeverityChart(report) {
    const sev = report.summary?.bySeverity || {};
    const labels = SEVERITY_ORDER.filter((s) => (sev[s] || 0) > 0 || true);
    const values = labels.map((s) => sev[s] || 0);
    const colors = labels.map((s) => SEVERITY_COLORS[s]);
    renderChart($("#chartSeverity"), { kind: "doughnut", labels, values, colors });
  }

  function aggregateDbs(report) {
    const byDb = new Map();
    for (const entry of report.normalized || []) {
      const dbs = entry?.normalized?.databases || [];
      for (const db of dbs) {
        if (!byDb.has(db.name)) byDb.set(db.name, { name: db.name, collections: 0, dataSize: 0, storageSize: 0, indexSize: 0 });
        const agg = byDb.get(db.name);
        agg.collections = Math.max(agg.collections, db.collections.length);
        // dbStats(1024*1024) reports MB.
        agg.dataSize = Math.max(agg.dataSize, Number(db.stats?.dataSize || 0));
        agg.storageSize = Math.max(agg.storageSize, Number(db.stats?.storageSize || 0));
        agg.indexSize = Math.max(agg.indexSize, Number(db.stats?.indexSize || 0));
      }
    }
    return Array.from(byDb.values()).sort((a, b) => b.storageSize - a.storageSize);
  }

  function aggregateCollections(report) {
    const out = [];
    const seen = new Set();
    for (const entry of report.normalized || []) {
      const dbs = entry?.normalized?.databases || [];
      for (const db of dbs) {
        for (const coll of db.collections) {
          const ns = `${db.name}.${coll.name}`;
          if (seen.has(ns)) continue;
          seen.add(ns);
          const s = coll.stats || {};
          const storageMb = Number(s.storageSize || 0);
          const wt = s.wiredTiger || {};
          const reusableMb = Number(wt["block-manager"]?.["file bytes available for reuse"] || 0) / 1024 / 1024;
          const frag = storageMb > 0 ? reusableMb / storageMb : 0;
          out.push({
            ns,
            count: Number(s.count || 0),
            dataSize: Number(s.size || 0),
            storageSize: storageMb,
            reusable: reusableMb,
            fragmentation: frag,
            totalIndexSize: Number(s.totalIndexSize || 0),
            indexCount: (coll.indexes || []).length,
          });
        }
      }
    }
    return out.sort((a, b) => b.storageSize - a.storageSize);
  }

  function fragColor(frag) {
    if (frag >= 0.5) return "#ff5050";
    if (frag >= 0.3) return "#ffb020";
    if (frag >= 0.1) return "#00a3ff";
    return "#00ed64";
  }

  function buildStorageChart(report) {
    const dbs = aggregateDbs(report);
    renderChart($("#chartStorage"), {
      kind: "hbar",
      labels: dbs.map((d) => d.name).slice(0, 10),
      values: dbs.map((d) => d.storageSize).slice(0, 10),
      colors: dbs.slice(0, 10).map((_, i) => PALETTE[i % PALETTE.length]),
      formatValue: (v) => fmtBytesMb(v),
    });
  }

  function buildCollectionsView(report) {
    const colls = aggregateCollections(report);
    const top = colls.slice(0, 30);
    renderChart($("#chartCollections"), {
      kind: "hbar",
      labels: top.map((c) => c.ns),
      values: top.map((c) => c.storageSize),
      colors: top.map((c) => fragColor(c.fragmentation)),
      formatValue: (v) => fmtBytesMb(v),
    });
    const body = $("#collectionsBody");
    body.innerHTML = "";
    for (const c of colls) {
      const tr = el("tr");
      tr.appendChild(el("td", null, c.ns));
      tr.appendChild(el("td", null, fmtInt(c.count)));
      tr.appendChild(el("td", null, fmtBytesMb(c.dataSize)));
      tr.appendChild(el("td", null, fmtBytesMb(c.storageSize)));
      tr.appendChild(el("td", null, fmtBytesMb(c.reusable)));
      const frag = c.storageSize > 0 ? (c.fragmentation * 100).toFixed(0) + "%" : "—";
      const tdF = el("td", null, frag);
      tdF.style.color = fragColor(c.fragmentation);
      tdF.style.fontWeight = "600";
      tr.appendChild(tdF);
      tr.appendChild(el("td", null, fmtBytesMb(c.totalIndexSize)));
      tr.appendChild(el("td", null, String(c.indexCount)));
      body.appendChild(tr);
    }
  }

  function buildDatabasesView(report) {
    const dbs = aggregateDbs(report);
    const body = $("#dbsBody");
    body.innerHTML = "";
    for (const d of dbs) {
      const tr = el("tr");
      tr.appendChild(el("td", null, d.name));
      tr.appendChild(el("td", null, String(d.collections)));
      tr.appendChild(el("td", null, fmtBytesMb(d.dataSize)));
      tr.appendChild(el("td", null, fmtBytesMb(d.storageSize)));
      tr.appendChild(el("td", null, fmtBytesMb(d.indexSize)));
      body.appendChild(tr);
    }
  }

  function buildIndexesView(report) {
    // Per-namespace count of used / unused.
    const perNs = new Map();
    for (const entry of report.normalized || []) {
      const dbs = entry?.normalized?.databases || [];
      for (const db of dbs) {
        for (const coll of db.collections) {
          const ns = `${db.name}.${coll.name}`;
          let used = 0, unused = 0;
          for (const idx of coll.indexStats || []) {
            const totalOps = (idx.stats || []).reduce((acc, h) => acc + Number(h.accesses || 0), 0);
            if (totalOps === 0) unused += 1; else used += 1;
          }
          if (used + unused === 0) continue;
          const existing = perNs.get(ns) || { ns, used: 0, unused: 0 };
          existing.used = Math.max(existing.used, used);
          existing.unused = Math.max(existing.unused, unused);
          perNs.set(ns, existing);
        }
      }
    }
    const rows = Array.from(perNs.values())
      .sort((a, b) => (b.used + b.unused) - (a.used + a.unused))
      .slice(0, 25);
    if (rows.length > 0) {
      renderChart($("#chartIndexes"), {
        kind: "stackedBar",
        labels: rows.map((r) => r.ns),
        datasets: [
          { label: "Used", data: rows.map((r) => r.used), backgroundColor: "#00ed64" },
          { label: "Unused (0 ops)", data: rows.map((r) => r.unused), backgroundColor: "#ff5050" },
        ],
      });
    }
    // List of unused / redundant findings already in `report.findings`.
    const findings = (report.findings || []).filter((f) => f.id === "IndexInfoItem");
    const content = $("#indexesContent");
    content.innerHTML = "";
    if (findings.length === 0) {
      content.appendChild(el("p", { class: "report-muted" }, "No index findings."));
      return;
    }
    findings.forEach((f) => content.appendChild(findingItem(f)));
  }

  function buildNodesView(report) {
    const body = $("#nodesContent");
    body.innerHTML = "";
    for (const node of report.nodes || []) {
      const normalized = (report.normalized || []).find((n) => n.host === node.host)?.normalized;
      const ss = normalized?.server?.serverStatus || {};
      const card = el("div", { class: "report-node-card" });
      card.appendChild(el("div", { class: "report-node-head" },
        el("span", { class: "report-node-host" }, node.host),
        el("span", { class: `report-node-role role-${(node.role || "unknown").toLowerCase()}` }, node.role || "—"),
        topologyBadge(node.setName || "—"),
      ));
      const grid = el("div", { class: "report-kv-grid" });
      const kv = (k, v) => {
        grid.appendChild(el("span", { class: "report-kv-k" }, k));
        grid.appendChild(el("span", { class: "report-kv-v" }, v == null ? "—" : String(v)));
      };
      kv("MongoDB version", ss.version);
      kv("Process", ss.process);
      kv("Uptime", ss.uptime ? `${Math.round(ss.uptime / 3600)} h` : "—");
      kv("Connections in use", ss.connections?.current);
      kv("Connections available", ss.connections?.available);
      kv("OS", normalized?.server?.hostInfo?.os?.name);
      kv("CPU cores", normalized?.server?.hostInfo?.system?.numCores);
      kv("RAM (GB)", normalized?.server?.hostInfo?.system?.memSizeMB
        ? (normalized.server.hostInfo.system.memSizeMB / 1024).toFixed(1)
        : "—");
      kv("File path / config", normalized?.server?.cmdLine?.parsed?.config);
      kv("Replica set", normalized?.setName);
      kv("Captured at", fmtDate(normalized?.capturedAt));
      card.appendChild(grid);
      body.appendChild(card);
    }
  }

  function buildParametersView(report) {
    const body = $("#paramsContent");
    body.innerHTML = "";
    for (const entry of report.normalized || []) {
      const params = entry?.normalized?.server?.parameters;
      const card = el("div", { class: "report-node-card" });
      card.appendChild(el("div", { class: "report-node-head" },
        el("span", { class: "report-node-host" }, entry.host),
      ));
      if (!params) {
        card.appendChild(el("p", { class: "report-muted" }, "Server parameters not captured for this node."));
      } else {
        const grid = el("div", { class: "report-kv-grid report-params-grid" });
        Object.keys(params).sort().forEach((k) => {
          if (k.startsWith("$") || k === "ok") return;
          const v = params[k];
          const s = typeof v === "object" ? JSON.stringify(v) : String(v);
          grid.appendChild(el("span", { class: "report-kv-k" }, k));
          grid.appendChild(el("span", { class: "report-kv-v report-params-val" }, s.length > 200 ? s.slice(0, 200) + "…" : s));
        });
        card.appendChild(grid);
      }
      body.appendChild(card);
    }
  }

  // ─── findings rendering (grouped + actionable) ───

  function copyToClipboard(text, button) {
    const done = (ok) => {
      if (!button) return;
      const original = button.dataset.originalLabel || button.textContent;
      button.dataset.originalLabel = original;
      button.textContent = ok ? "✓ Copied" : "Copy failed";
      button.classList.add(ok ? "copied" : "copy-failed");
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove("copied", "copy-failed");
      }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      return;
    }
    // Fallback for file:// and other non-secure contexts (used in the offline HTML).
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      done(ok);
    } catch (_) {
      done(false);
    }
  }

  function actionBlock(action) {
    const wrap = el("div", { class: `report-action report-action-${action.kind || "generic"}` });
    const head = el("div", { class: "report-action-head" },
      el("span", { class: "report-action-label" }, action.label || "Suggested command"),
    );
    if (action.link) {
      head.appendChild(el("a", {
        class: "report-action-link",
        href: action.link,
        target: "_blank",
        rel: "noopener noreferrer",
        title: action.link,
      }, action.linkLabel || "Docs"));
    }
    head.appendChild(el("button", {
      type: "button",
      class: "btn-secondary btn-mini report-action-copy",
      onclick: (ev) => copyToClipboard(action.command || "", ev.currentTarget),
    }, "Copy"));
    wrap.appendChild(head);
    if (action.warning) {
      wrap.appendChild(el("div", { class: "report-action-warning" }, action.warning));
    }
    const pre = el("pre", { class: "report-action-pre" });
    pre.textContent = action.command || "";
    wrap.appendChild(pre);
    return wrap;
  }

  function findingItem(f, options) {
    const opts = options || {};
    const head = el("div", { class: "report-finding-head" },
      severityBadge(f.severity),
      el("span", { class: "report-finding-title" }, f.title || "(no title)"),
    );
    if (f.docs) {
      head.appendChild(el("a", {
        class: "report-finding-doc",
        href: f.docs,
        target: "_blank",
        rel: "noopener noreferrer",
        title: f.docs,
      }, "Docs"));
    }
    const metaBits = [];
    if (f.meta) metaBits.push(f.meta);
    if (f.host) metaBits.push(f.host);
    if (metaBits.length > 0) {
      head.appendChild(el("span", { class: "report-finding-meta" }, `· ${metaBits.join(" · ")}`));
    }
    const node = el("div", { class: `report-finding sev-${(f.severity || "info").toLowerCase()}-border` },
      head,
      el("div", { class: "report-finding-desc" }, f.description || ""),
    );
    // Per-finding action snippets only render when the caller asks for them (e.g. the
    // Cluster group, where there is typically just one oplog finding so the snippets
    // belong next to it). For high-cardinality groups (Indexes, Collections) the
    // snippets are surfaced once at the group level via the advice card / bulk buttons.
    if (opts.showActions && Array.isArray(f.actions) && f.actions.length > 0) {
      const actionsWrap = el("div", { class: "report-finding-actions" });
      f.actions.forEach((a) => actionsWrap.appendChild(actionBlock(a)));
      node.appendChild(actionsWrap);
    }
    return node;
  }

  function groupHeader(item, findings) {
    const head = el("div", { class: "report-findings-group-head" });
    head.appendChild(el("h3", { class: "report-findings-group-title" }, item || "Other"));
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    findings.forEach((f) => { counts[(f.severity || "INFO").toUpperCase()] += 1; });
    const pills = el("div", { class: "report-findings-group-pills" });
    SEVERITY_ORDER.forEach((s) => {
      if (counts[s] > 0) pills.appendChild(el("span", { class: `sev-pill sev-${s.toLowerCase()}` }, `${counts[s]} ${s}`));
    });
    head.appendChild(pills);
    // Bulk-script buttons are owned by the per-group advice card; we keep this header
    // minimal so the eye lands on the explanation first.
    return head;
  }

  // Severity sort key — lower index = higher severity = sorted first.
  function sevRank(sev) {
    const i = SEVERITY_ORDER.indexOf((sev || "INFO").toUpperCase());
    return i === -1 ? SEVERITY_ORDER.length : i;
  }

  // ─── group-level advice (one card per group, mirroring the live dashboard) ───

  // Each entry returns { title, explanation, warning, bullets[], scripts[] }. `scripts`
  // are derived from per-finding actions so the bulk Copy buttons stay accurate even when
  // the user changes the underlying check thresholds.
  function adviceForGroup(item, findings) {
    switch (item) {
      case "Collections":  return collectionsAdvice(findings);
      case "Indexes":      return indexesAdvice(findings);
      case "Cluster":      return clusterAdvice(findings);
      case "Host info":    return hostInfoAdvice(findings);
      case "Security":     return securityAdvice(findings);
      case "Build info":   return buildInfoAdvice(findings);
      case "Server status":return serverStatusAdvice(findings);
      case "Sharding":     return shardingAdvice(findings);
      default:             return null;
    }
  }

  function bulkScriptFromFindings(findings, kind, header) {
    const actions = findings.flatMap((f) => f.actions || []).filter((a) => a.kind === kind);
    if (actions.length === 0) return null;
    return [header.trim(), "", ...actions.map((a) => a.command + "\n")].join("\n");
  }

  function collectionsAdvice(findings) {
    const compactBulk = bulkScriptFromFindings(
      findings,
      "compact",
      "// MongoAdvisor — bulk COMPACT for fragmented collections in this group.\n" +
        "// [Warning] STAGING FIRST. compact holds an exclusive lock on each collection on\n" +
        "// the node it runs on — run rolling: connect to a SECONDARY, run there, step the\n" +
        "// PRIMARY down, repeat. On Atlas you cannot run compact — request a rolling resync\n" +
        "// from MongoDB Support instead.",
    );
    return {
      title: "Storage fragmentation",
      explanation:
        "Fragmentation mainly matters when you are disk-bound or need to shrink storage. WiredTiger does not return reusable space to the OS on its own, but it will reuse that space for new writes — so a high fragmentation ratio is not, by itself, a performance issue.",
      bullets: [
        "Run `compact` (MongoDB ≤ 7) or `autoCompact` (MongoDB 8.0+) during a maintenance window, secondaries first, PRIMARY last via step-down.",
        "On Atlas, `compact` is not available — open a support ticket to request a rolling resync, which rebuilds each member from a fresh snapshot.",
        "For very large collections that are upstream-sourced (CDC, ETL), it can be faster to drop and re-create from the source than to compact in place.",
      ],
      docs: "https://www.mongodb.com/docs/manual/reference/command/compact/",
      scripts: compactBulk
        ? [
            {
              label: "Copy bulk compact script",
              text: compactBulk,
            },
          ]
        : [],
    };
  }

  function indexesAdvice(findings) {
    const hideBulk = bulkScriptFromFindings(
      findings,
      "hideIndex",
      "// MongoAdvisor — bulk HIDE for unused / redundant indexes in this group.\n" +
        "// [Warning] STAGING FIRST. Hidden indexes stay on disk but are ignored by the\n" +
        "// planner. Observe one full business cycle before dropping. Unhide if anything\n" +
        "// regresses.",
    );
    const dropBulk = bulkScriptFromFindings(
      findings,
      "dropIndex",
      "// MongoAdvisor — bulk DROP for unused / redundant indexes in this group.\n" +
        "// [Warning] Irreversible. Run only after a hidden-state observation period or in\n" +
        "// staging. Rebuilding a dropped index on a large collection is expensive.",
    );
    const scripts = [];
    if (hideBulk) scripts.push({ label: "Copy hide-all script", text: hideBulk });
    if (dropBulk) scripts.push({ label: "Copy drop-all script", text: dropBulk });
    return {
      title: "Index hygiene",
      warning:
        "[Warning] Test in staging before applying to production. An index that looks unused over the captured window may still be needed for end-of-month / year-end / rare reports.",
      bullets: [
        "Double-check the application code to confirm each candidate index is not used in any query. `$indexStats` only sees what's been queried since the stats counter was last reset (server restart, version upgrade, etc.).",
        "Hide indexes first (`hideIndex`) — this is reversible. Watch for slow-query regressions across one full business cycle.",
        "Drop the index (`dropIndex`) only after the observation period. Dropping is irreversible; rebuilding on a large collection is expensive.",
        "Redundant indexes (key A is a strict prefix of key B) are the safest candidates: any query the shorter index could serve, the longer one already serves.",
      ],
      docs: "https://www.mongodb.com/docs/manual/core/indexes/",
      scripts,
    };
  }

  function clusterAdvice(findings) {
    // Oplog is the most common Cluster finding — there is typically one per replica-set
    // group, with platform-specific actions already attached. We surface those snippets
    // inline in the advice card so the reader sees one unified explanation per group.
    const oplog = findings.find((f) => /oplog window/i.test(f.title || ""));
    const bullets = [];
    if (oplog) {
      bullets.push(
        "A short oplog window reduces resilience — secondaries, change streams, downstream consumers (Search, Triggers, Sync) all need the oplog to catch up.",
        "Recommended minimum is 48 h so the cluster can survive a maintenance window or a full resync without falling out of sync.",
      );
      if (oplog.platform === "atlas") {
        bullets.push(
          "Atlas blocks the `replSetResizeOplog` shell command. Use the Additional Settings pane in the UI, the Atlas CLI, or the Admin API — Atlas rolls each shard / config replica set automatically.",
        );
      } else {
        bullets.push(
          "On self-managed, run `replSetResizeOplog` rolling — secondaries first, then step the PRIMARY down.",
        );
      }
    }
    const lag = findings.find((f) => /Secondary lag/i.test(f.title || ""));
    if (lag) {
      bullets.push(
        "Secondary lag almost always points to slow disk on the replica, a network bottleneck, or batch-apply contention. Check disk latency and replication network throughput first.",
      );
    }
    const noPrimary = findings.find((f) => /no PRIMARY/i.test(f.title || ""));
    if (noPrimary) {
      bullets.push(
        "No PRIMARY means reads/writes are stalled. Inspect election logs and member states immediately — usually a recent partition or a downed member.",
      );
    }
    if (bullets.length === 0) {
      bullets.push("Inspect the individual cluster findings below for details.");
    }
    return {
      title: "Replica-set health",
      bullets,
      docs:
        oplog && oplog.platform === "atlas"
          ? "https://www.mongodb.com/docs/atlas/cluster-additional-settings/#set-minimum-oplog-window"
          : "https://www.mongodb.com/docs/manual/core/replica-set-oplog/",
      // Render the oplog finding's platform-specific snippets inline in the advice card.
      inlineActions: oplog ? (oplog.actions || []) : [],
    };
  }

  function hostInfoAdvice(findings) {
    const ulimit = findings.find((f) => /ulimit/i.test(f.title || ""));
    return {
      title: "Host configuration",
      bullets: [
        "Production MongoDB runs on Linux with NUMA pinned (`numactl --interleave=all`) and `ulimit -n` ≥ 64 000 — without these, you'll hit connection-storm and memory-locality issues under load.",
        "Verify with `cat /proc/<mongod-pid>/limits` on each member.",
      ],
      docs: "https://www.mongodb.com/docs/manual/administration/production-checklist-operations/",
      inlineActions: ulimit ? (ulimit.actions || []) : [],
    };
  }

  function securityAdvice() {
    return {
      title: "Security posture",
      bullets: [
        "Authentication should be enabled cluster-wide (SCRAM, x509, or LDAP) and TLS should be `requireTLS` — anything weaker accepts unencrypted client traffic.",
        "Disable server-side JavaScript (`security.javascriptEnabled: false`) unless `$where` / `mapReduce` is actually in use — it narrows the attack surface.",
        "Once the deployment has any user, set `enableLocalhostAuthBypass` to 0 so the bypass cannot be re-armed.",
      ],
      docs: "https://www.mongodb.com/docs/manual/security-checklist/",
    };
  }

  function buildInfoAdvice() {
    return {
      title: "Server version",
      bullets: [
        "Stay on a supported major release. End-of-life versions stop receiving security fixes — plan an upgrade before the EOL date.",
        "On Atlas, upgrade through the UI (Versions tab). On self-managed, follow the rolling upgrade procedure: secondaries first, then step down the PRIMARY.",
      ],
      docs: "https://www.mongodb.com/legal/support-policy/lifecycles",
    };
  }

  function serverStatusAdvice() {
    return {
      title: "Runtime counters",
      bullets: [
        "Connection saturation usually means a client-side connection pool is too large — audit driver `maxPoolSize` before raising `net.maxIncomingConnections`.",
        "High `scanned : returned` (query targeting) ratios are the classic signal of a missing or unselective index. Cross-reference with the Indexes findings.",
        "Sustained `bytes read into cache` per second above the threshold usually means the working set no longer fits in RAM — either resize the cache or scale the instance.",
      ],
      docs: "https://www.mongodb.com/docs/manual/reference/command/serverStatus/",
    };
  }

  function shardingAdvice() {
    return {
      title: "Sharding & balancer",
      bullets: [
        "Persistent chunk imbalance points at either a low-cardinality shard key or a balancer disabled for too long.",
        "If the balancer is not in `full` mode, re-enable it with `sh.startBalancer()` once the underlying issue is understood.",
        "For jumbo chunks, refine the shard key — `reshardCollection` is supported on 5.0+.",
      ],
      docs: "https://www.mongodb.com/docs/manual/core/sharding-balancer/",
    };
  }

  function adviceCard(advice) {
    const card = el("div", { class: "report-group-advice" });
    const head = el("div", { class: "report-group-advice-head" },
      el("span", { class: "report-group-advice-title" }, advice.title || "Recommended actions"),
    );
    if (advice.docs) {
      head.appendChild(el("a", {
        class: "report-finding-doc",
        href: advice.docs,
        target: "_blank",
        rel: "noopener noreferrer",
        title: advice.docs,
      }, "Docs"));
    }
    card.appendChild(head);
    if (advice.explanation) {
      card.appendChild(el("p", { class: "report-group-advice-text" }, advice.explanation));
    }
    if (advice.warning) {
      card.appendChild(el("p", { class: "report-group-advice-warning" }, advice.warning));
    }
    if (Array.isArray(advice.bullets) && advice.bullets.length > 0) {
      card.appendChild(el("div", { class: "report-group-advice-subtitle" }, "Recommended actions"));
      const ul = el("ul", { class: "report-group-advice-bullets" });
      advice.bullets.forEach((b) => ul.appendChild(el("li", null, b)));
      card.appendChild(ul);
    }
    // Bulk-script "Copy" buttons (text-only payload, no inline pre).
    if (Array.isArray(advice.scripts) && advice.scripts.length > 0) {
      const tools = el("div", { class: "report-group-advice-tools" });
      advice.scripts.forEach((s) => {
        tools.appendChild(el("button", {
          type: "button",
          class: "btn-secondary btn-mini",
          onclick: (ev) => copyToClipboard(s.text, ev.currentTarget),
        }, s.label));
      });
      card.appendChild(tools);
    }
    // Inline per-finding actions (e.g. the oplog snippets) — these include their own pre
    // block and Copy button so the reader can pick the snippet that fits their setup.
    if (Array.isArray(advice.inlineActions) && advice.inlineActions.length > 0) {
      const actions = el("div", { class: "report-finding-actions" });
      advice.inlineActions.forEach((a) => actions.appendChild(actionBlock(a)));
      card.appendChild(actions);
    }
    return card;
  }

  function buildFindingsList(report) {
    const wrap = $("#findingsList");
    wrap.innerHTML = "";
    const findings = (report.findings || []).slice();
    if (findings.length === 0) {
      wrap.appendChild(el("p", { class: "report-muted" }, "No findings — every check passed."));
      return;
    }

    // Group by check item label, preserving original `id` as a fallback. The summary card
    // already showed the global totals, so here we want one section per check category.
    const groups = new Map();
    for (const f of findings) {
      const key = f.item || f.id || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    // Sort: groups by their max severity (HIGH first), then by group name; findings
    // inside each group by severity then host.
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      const sa = Math.min(...a[1].map((f) => sevRank(f.severity)));
      const sb = Math.min(...b[1].map((f) => sevRank(f.severity)));
      if (sa !== sb) return sa - sb;
      return a[0].localeCompare(b[0]);
    });

    for (const [item, list] of sortedGroups) {
      list.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || String(a.host || "").localeCompare(String(b.host || "")));
      const section = el("div", { class: "report-findings-group" });
      section.appendChild(groupHeader(item, list));
      const advice = adviceForGroup(item, list);
      if (advice) section.appendChild(adviceCard(advice));
      const body = el("div", { class: "report-findings-group-body" });
      // The Cluster group typically has 1-2 actionable findings (oplog), and its advice
      // card already inlines those snippets, so don't render per-finding actions again.
      list.forEach((f) => body.appendChild(findingItem(f, { showActions: false })));
      section.appendChild(body);
      wrap.appendChild(section);
    }
  }

  function buildSummaryCard(report) {
    $("#rsName").textContent = report.name || "(no name)";
    $("#rsTopology").textContent = report.topology || "—";
    const sv = report.summary || {};
    $("#rsCounts").textContent = `${sv.nodeCount || (report.nodes || []).length} nodes · ${sv.totalCollections || 0} collections · ${sv.totalIndexes || 0} indexes`;
    const sev = sv.bySeverity || {};
    const f = $("#rsFindings");
    f.innerHTML = "";
    let any = false;
    ["HIGH", "MEDIUM", "LOW", "INFO"].forEach((s) => {
      if (sev[s]) {
        f.appendChild(el("span", { class: `sev-pill sev-${s.toLowerCase()}` }, `${sev[s]} ${s}`));
        any = true;
      }
    });
    if (!any) f.appendChild(el("span", { class: "report-muted" }, "none"));
    // The html-builder strips this anchor for the offline file, so it may not exist.
    const dl = $("#rsDownload");
    if (dl) dl.setAttribute("href", `/api/reports/${report._id}/download.html`);
  }

  function buildRawView(report) {
    const pre = $("#rawJsonPre");
    pre.textContent = JSON.stringify(report.normalized, null, 2);
  }

  function setupTabs() {
    const tabs = $all("#reportTabs button");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        tabs.forEach((b) => b.classList.toggle("active", b === btn));
        $all('[data-tab-pane]').forEach((pane) => {
          pane.hidden = pane.dataset.tabPane !== tab;
        });
      });
    });
  }

  function renderReport(report) {
    hide($("#reportLoading"));
    show($("#reportSingleView"));
    buildSummaryCard(report);
    buildFindingsList(report);
    buildSeverityChart(report);
    buildStorageChart(report);
    buildNodesView(report);
    buildDatabasesView(report);
    buildCollectionsView(report);
    buildIndexesView(report);
    buildParametersView(report);
    buildRawView(report);
    setupTabs();
  }

  // ─── boot ───
  function readEmbedded() {
    const node = document.getElementById("reportData");
    if (!node) return null;
    const txt = node.textContent.trim();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  function refreshHealthBadge() {
    fetch("/api/health").then((r) => r.json()).then((j) => {
      const b = document.getElementById("mongoStatus");
      const dot = document.getElementById("statusDot");
      if (j.status === "ok") {
        b.textContent = "connected";
        b.className = "badge ok";
        dot.style.background = "#00ed64";
      } else {
        b.textContent = "error";
        b.className = "badge err";
        dot.style.background = "#ff5050";
      }
    }).catch(() => {
      const b = document.getElementById("mongoStatus");
      b.textContent = "offline";
      b.className = "badge err";
    });
  }

  async function boot() {
    const embedded = readEmbedded();
    if (embedded) {
      // Self-contained download mode. The html-builder may strip the status badge
      // entirely (no /api/health to talk to), so guard against it being missing.
      const badge = document.getElementById("mongoStatus");
      if (badge) {
        badge.textContent = "offline";
        badge.className = "badge";
      }
      hide($("#reportListView"));
      renderReport(embedded);
      return;
    }
    refreshHealthBadge();
    if (reportId) {
      hide($("#reportListView"));
      try {
        const report = await fetchJSON(`/api/reports/${reportId}`);
        renderReport(report);
      } catch (err) {
        hide($("#reportLoading"));
        const e = $("#reportError");
        e.textContent = "Could not load report: " + err.message;
        show(e);
      }
    } else {
      hide($("#reportLoading"));
      show($("#reportListView"));
      setupUpload();
      loadList();
    }
  }

  boot();
})();
