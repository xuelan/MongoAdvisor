/**
 * ClusterItem — replica-set health: PRIMARY exists, replication lag, oplog window.
 *
 * Defaults: `replication_lag_seconds: 0` (any lag flags) and `oplog_window_hours: 48`.
 * The 0 s lag floor is stricter than what most production teams use day-to-day, but it
 * makes any non-zero lag immediately visible in the report.
 */

function run(report, thresholds) {
  const t = thresholds?.ClusterItem || {};
  const findings = [];

  // One pass per replica-set group so we only emit cluster-wide findings once.
  for (const group of report.groups) {
    const rsNode = group.nodes.find((n) => n.normalized?.replicaSet);
    if (!rsNode) continue;
    const status = rsNode.normalized.replicaSet.status;
    const info = rsNode.normalized.replicaSet.info;

    if (status?.members) {
      const primary = status.members.find((m) => m.stateStr === "PRIMARY");
      if (!primary) {
        findings.push({
          host: group.setName || rsNode.host,
          severity: "HIGH",
          title: "Replica set has no PRIMARY",
          description: `rs.status() shows no PRIMARY among ${status.members.length} members. Reads / writes will fail until an election completes.`,
        });
      } else if (typeof t.replication_lag_seconds === "number") {
        const primaryDate =
          (primary.optimeDate && new Date(primary.optimeDate).getTime()) || 0;
        for (const m of status.members) {
          if (m.stateStr !== "SECONDARY") continue;
          const secDate =
            (m.optimeDate && new Date(m.optimeDate).getTime()) || 0;
          const lagSec = Math.max(0, Math.round((primaryDate - secDate) / 1000));
          if (lagSec > t.replication_lag_seconds) {
            findings.push({
              host: m.name,
              severity: lagSec > 30 ? "HIGH" : "MEDIUM",
              title: `Secondary lag ${lagSec} s`,
              description: `Member ${m.name} is ${lagSec} s behind the primary (threshold ${t.replication_lag_seconds} s). Investigate network / I/O / batch-apply contention.`,
            });
          }
        }
      }
    }

    if (info && typeof info.timeDiffHours === "number") {
      const need = t.oplog_window_hours || 48;
      if (info.timeDiffHours < need) {
        findings.push({
          host: group.setName || rsNode.host,
          severity: "HIGH",
          title: `Oplog window only ${info.timeDiffHours.toFixed(1)} h`,
          description: `db.getReplicationInfo() reports a ${info.timeDiffHours.toFixed(1)} h window. Recommended minimum is ${need} h to survive maintenance / resync windows. Raise \`replication.oplogSizeMB\` (Atlas: ProcessArgs.oplogSizeMB) or \`oplogMinRetentionHours\`.`,
        });
      }
    }
  }
  return findings;
}

module.exports = {
  id: "ClusterItem",
  label: "Cluster",
  run,
};
