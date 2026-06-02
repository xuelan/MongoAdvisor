/**
 * ClusterItem — replica-set health: PRIMARY exists, replication lag, oplog window.
 *
 * Defaults: `replication_lag_seconds: 0` (any lag flags) and `oplog_window_hours: 48`.
 * The 0 s lag floor is stricter than what most production teams use day-to-day, but it
 * makes any non-zero lag immediately visible in the report.
 */

const ATLAS_DOCS_OPLOG_WINDOW =
  "https://www.mongodb.com/docs/atlas/customize-storage/#std-label-oplog-size-behavior/";
const SERVER_OPLOG_DOCS =
  "https://www.mongodb.com/docs/manual/core/replica-set-oplog/";

function looksLikeAtlas(group) {
  const hostMatches = group.nodes.some((n) => /\.mongodb\.net(:|$)/i.test(n.host || ""));
  const setMatches = /^atlas-/i.test(group.setName || "");
  return hostMatches || setMatches;
}

function buildOplogActions({ isAtlas, need, suggestedMb }) {
  if (isAtlas) {
    return [];
  }
  return [
    {
      kind: "resizeOplog",
      label: `Resize oplog to ${suggestedMb} MB (mongosh)`,
      warning:
        "Self-managed only. Run rolling — connect to each member directly, secondaries first, step down the PRIMARY last. Atlas blocks this command.",
      link: SERVER_OPLOG_DOCS,
      linkLabel: "Server docs",
      command:
        "// Per-member: connect directly to each mongod (not via the router) and run:\n" +
        `db.adminCommand({ replSetResizeOplog: 1, size: ${suggestedMb} });`,
    },
    {
      kind: "minRetention",
      label: `Set minimum retention to ${need} h (mongosh)`,
      warning:
        "Self-managed only. `minRetentionHours` keeps oplog entries beyond the size cap until the window is met — useful when size fluctuates.",
      link: SERVER_OPLOG_DOCS,
      linkLabel: "Server docs",
      command:
        "// Per-member: connect directly to each mongod and run:\n" +
        `db.adminCommand({ replSetResizeOplog: 1, minRetentionHours: ${need} });`,
    },
  ];
}

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
        // Suggest a size bump: enough margin to absorb resync / maintenance windows
        // (need × current MB/h, with a 1.5× safety factor and a 990 MB floor — the
        // minimum oplog the server will accept).
        const currentSizeMb = Number(info.logSizeMB) || 0;
        const usedSizeMb = Number(info.usedMB) || 0;
        const ratePerHour = info.timeDiffHours > 0 ? usedSizeMb / info.timeDiffHours : 0;
        const suggestedMb = Math.max(990, Math.ceil((ratePerHour * need * 1.5) || currentSizeMb * 2));
        const isAtlas = looksLikeAtlas(group);
        const platformLabel = isAtlas ? "Atlas" : "self-managed";
        findings.push({
          host: group.setName || rsNode.host,
          setName: group.setName,
          platform: isAtlas ? "atlas" : "self-managed",
          severity: "HIGH",
          title: `Oplog window only ${info.timeDiffHours.toFixed(1)} h`,
          description:
            `db.getReplicationInfo() reports a ${info.timeDiffHours.toFixed(1)} h window. ` +
            `Recommended minimum is ${need} h to survive maintenance / resync windows. ` +
            (isAtlas
              ? "Detected as Atlas. Depending on whether you choose to use storage auto-scaling, Atlas manages oplog entries based on either the minimum oplog retention window, or the oplog size."
              : "Raise `replication.oplogSizeMB` and/or set `oplogMinRetentionHours` on each member."),
          docs: isAtlas ? ATLAS_DOCS_OPLOG_WINDOW : SERVER_OPLOG_DOCS,
          actions: buildOplogActions({ isAtlas, need, suggestedMb }),
          // Surface platform in the meta line so a reader knows why the snippets differ.
          meta: `${platformLabel} · suggested size ${suggestedMb} MB`,
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
