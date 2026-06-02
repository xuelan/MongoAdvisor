/**
 * CollInfoItem — per-collection sanity:
 *   - average document size (`avgObjSize` from collStats)
 *   - collection size in GB (`storageSize`)
 *   - fragmentation ratio (`block-manager.file bytes available for reuse` / `storageSize`)
 *   - index size relative to data (`totalIndexSize` / `storageSize`)
 *
 * Thresholds live in `./thresholds.js`.
 */

const SYS_DB_NAMES = new Set(["admin", "config", "local"]);

function freeStorageBytes(stats) {
  if (!stats) return 0;
  // collStats(scale = 1024 * 1024) returns storageSize already in MB, but the inner
  // WiredTiger counters are still in bytes. We use the WT "file bytes available for
  // reuse" counter as the fragmentation numerator — convert to MB to match storageSize.
  const wt = stats.wiredTiger || {};
  const bytes = Number(wt["block-manager"]?.["file bytes available for reuse"] || 0);
  return bytes / 1024 / 1024;
}

function run(report, thresholds) {
  const t = thresholds?.CollInfoItem || {};
  const findings = [];

  for (const node of report.nodes) {
    // collStats only makes sense per-mongod; skip mongos (would double-count via shards).
    if (node.role === "MONGOS") continue;
    const dbs = node.normalized?.databases || [];
    for (const db of dbs) {
      if (SYS_DB_NAMES.has(db.name)) continue;
      for (const coll of db.collections) {
        const s = coll.stats;
        if (!s) continue;
        const ns = `${db.name}.${coll.name}`;

        const avgObjKb = (Number(s.avgObjSize) || 0) / 1024;
        if (t.obj_size_kb && avgObjKb > t.obj_size_kb) {
          findings.push({
            host: node.host,
            severity: "MEDIUM",
            title: `Large average document in ${ns} (${avgObjKb.toFixed(1)} KB)`,
            description: `\`avgObjSize\` is ${avgObjKb.toFixed(1)} KB, above ${t.obj_size_kb} KB. Consider field-level projection on hot paths or splitting blob fields.`,
          });
        }

        const sizeGb = (Number(s.storageSize) || 0) / 1024; // storageSize is in MB after scale
        if (t.collection_size_gb && sizeGb > t.collection_size_gb) {
          findings.push({
            host: node.host,
            severity: "MEDIUM",
            title: `Collection ${ns} is ${sizeGb.toFixed(1)} GB`,
            description: `Large collections increase resync time and limit options for index changes. Consider archiving via TTL or sharding.`,
          });
        }

        const storageMb = Number(s.storageSize) || 0;
        if (storageMb > 0) {
          const freeMb = freeStorageBytes(s);
          const frag = freeMb / storageMb;
          if (t.fragmentation_ratio && frag > t.fragmentation_ratio) {
            findings.push({
              host: node.host,
              namespace: ns,
              severity: "MEDIUM",
              title: `Fragmentation ${Math.round(frag * 100)}% on ${ns}`,
              description: `WiredTiger reports ${freeMb.toFixed(0)} MB reusable of ${storageMb.toFixed(0)} MB storage size. Compact during a maintenance window or rolling-resync — see https://www.mongodb.com/docs/manual/reference/command/compact/.`,
              actions: [
                {
                  kind: "compact",
                  label: "Reclaim reusable bytes (mongosh)",
                  warning:
                    "compact holds an exclusive lock on the collection on this node — run rolling, secondary first, then step-down and repeat on the old PRIMARY. Atlas: contact support / use rolling-resync.",
                  command:
                    "// Connect to a SECONDARY (or run rolling across the set)\n" +
                    `db = db.getSiblingDB(${JSON.stringify(db.name)});\n` +
                    `db.runCommand({ compact: ${JSON.stringify(coll.name)}, force: true });`,
                },
              ],
            });
          }

          const totalIdx = Number(s.totalIndexSize) || 0;
          const idxRatio = totalIdx / storageMb;
          if (t.index_size_ratio && idxRatio > t.index_size_ratio) {
            findings.push({
              host: node.host,
              namespace: ns,
              severity: "LOW",
              title: `Index footprint ${Math.round(idxRatio * 100)}% on ${ns}`,
              description: `\`totalIndexSize\` / \`storageSize\` = ${idxRatio.toFixed(2)} (threshold ${t.index_size_ratio}). Drop unused / redundant indexes — see the Indexes section.`,
            });
          }
        }
      }
    }
  }
  return findings;
}

module.exports = {
  id: "CollInfoItem",
  label: "Collections",
  run,
};
