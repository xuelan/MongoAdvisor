/**
 * Check registry + orchestrator. Each item module exports `{ id, item, run(report, thresholds) }`
 * and may return any number of findings. `runAll` catches per-item failures so a buggy
 * check can't break the whole report — it shows up as an INFO finding instead.
 */

const thresholds = require("./thresholds");

const ITEMS = [
  require("./build-info"),
  require("./security"),
  require("./host-info"),
  require("./server-status"),
  require("./cluster"),
  require("./coll-info"),
  require("./index-info"),
  require("./shard-key"),
];

function runAll(report, customThresholds) {
  const cfg = customThresholds || thresholds;
  const findings = [];
  for (const item of ITEMS) {
    let itemFindings = [];
    try {
      itemFindings = item.run(report, cfg) || [];
    } catch (err) {
      // A buggy check should never fail the whole report — surface it as a LOW finding.
      itemFindings = [
        {
          host: "report",
          severity: "LOW",
          title: `Check ${item.id} crashed`,
          description: `Internal error: ${err.message}. The other checks still ran.`,
        },
      ];
    }
    for (const f of itemFindings) {
      findings.push({ id: item.id, item: item.label, ...f });
    }
  }
  return findings;
}

function summarize(findings) {
  const bySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) {
    const sev = (f.severity || "INFO").toUpperCase();
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }
  const byItem = {};
  for (const f of findings) {
    byItem[f.id] = (byItem[f.id] || 0) + 1;
  }
  return { bySeverity, byItem, total: findings.length };
}

module.exports = { runAll, summarize, ITEMS, thresholds };
