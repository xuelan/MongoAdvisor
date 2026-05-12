/**
 * ServerStatusItem — counter-based checks against `serverStatus`:
 *   - connections used / total ratio
 *   - query targeting (scanned : returned, scannedObjects : returned)
 *   - WT cache "bytes read into cache" per second (proxy for cache pressure)
 */

function safeRatio(num, den) {
  if (!den || den === 0) return 0;
  return num / den;
}

function run(report, thresholds) {
  const t = thresholds?.ServerStatusItem || {};
  const findings = [];

  for (const node of report.nodes) {
    const ss = node.normalized?.server?.serverStatus;
    if (!ss) continue;

    const used = ss.connections?.current || 0;
    const total = (ss.connections?.available || 0) + used;
    const ratio = safeRatio(used, total);
    if (t.used_connection_ratio && ratio >= t.used_connection_ratio) {
      findings.push({
        host: node.host,
        severity: "MEDIUM",
        title: `Connection usage at ${(ratio * 100).toFixed(0)}%`,
        description: `${used} of ${total} available connections in use, above the ${(t.used_connection_ratio * 100).toFixed(0)}% threshold. Audit app-side pool sizes or raise \`net.maxIncomingConnections\` carefully.`,
      });
    }

    const m = ss.metrics?.queryExecutor || {};
    const ops = ss.metrics?.document || {};
    const scanned = Number(m.scanned || 0);
    const scannedObjects = Number(m.scannedObjects || 0);
    const returned = Number(ops.returned || 0);
    if (returned > 0) {
      const keyRatio = scanned / returned;
      const objRatio = scannedObjects / returned;
      if (t.query_targeting && keyRatio > t.query_targeting) {
        findings.push({
          host: node.host,
          severity: "MEDIUM",
          title: `Index targeting ratio ${keyRatio.toFixed(0)}:1`,
          description: `\`metrics.queryExecutor.scanned\` / \`metrics.document.returned\` = ${keyRatio.toFixed(0)} (threshold ${t.query_targeting}). Add or refine indexes to reduce keys scanned per returned document.`,
        });
      }
      if (t.query_targeting_obj && objRatio > t.query_targeting_obj) {
        findings.push({
          host: node.host,
          severity: "MEDIUM",
          title: `Document targeting ratio ${objRatio.toFixed(0)}:1`,
          description: `\`metrics.queryExecutor.scannedObjects\` / \`metrics.document.returned\` = ${objRatio.toFixed(0)} (threshold ${t.query_targeting_obj}). Look for COLLSCANs in the slow-query log and back them with indexes.`,
        });
      }
    }

    const wt = ss.wiredTiger || {};
    const bytesRead = Number(wt.cache?.["bytes read into cache"] || 0);
    const uptime = Number(ss.uptime || 0);
    if (uptime > 0) {
      const mbPerSec = bytesRead / 1024 / 1024 / uptime;
      if (t.cache_read_into_mb && mbPerSec > t.cache_read_into_mb) {
        findings.push({
          host: node.host,
          severity: "MEDIUM",
          title: `WT cache fill ${mbPerSec.toFixed(1)} MB/s`,
          description: `Average \`wiredTiger.cache."bytes read into cache"\` over the server uptime exceeds the threshold (${t.cache_read_into_mb} MB/s). Working-set fit may be the bottleneck — consider larger cache or faster storage.`,
        });
      }
    }
  }
  return findings;
}

module.exports = {
  id: "ServerStatusItem",
  label: "Server status",
  run,
};
