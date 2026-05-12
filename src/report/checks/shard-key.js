/**
 * ShardKeyItem — only runs when the upload includes a mongos / shard_info section.
 *
 * Currently checks `sharding_imbalance_percentage` (max-min chunk count vs. average) and
 * surfaces a single MEDIUM finding when chunk distribution is uneven beyond the threshold.
 * Full chunk-level analysis (jumbo chunks, zone violations) is a follow-up.
 */

function run(report, thresholds) {
  const t = thresholds?.ShardKeyItem || {};
  const findings = [];

  // ShardKeyItem only triggers when we have shard data — i.e. a mongos capture was uploaded.
  const mongosNode = report.nodes.find((n) => n.normalized?.shardInfo);
  if (!mongosNode) return findings;

  const shardInfo = mongosNode.normalized.shardInfo || {};
  const shardedDbs = shardInfo.sharded_databases || [];
  if (!Array.isArray(shardedDbs)) return findings;

  for (const db of shardedDbs) {
    const collections = db.collections || [];
    for (const coll of collections) {
      const dist = coll.distribution || [];
      if (dist.length < 2) continue;
      const counts = dist.map((d) => Number(d.nChunks) || 0);
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      const imbalance = (max - min) / total;
      if (t.sharding_imbalance_percentage && imbalance > t.sharding_imbalance_percentage) {
        findings.push({
          host: coll._id || db._id || "cluster",
          severity: "MEDIUM",
          title: `Chunk imbalance on ${coll._id || "sharded collection"} (${Math.round(imbalance * 100)}%)`,
          description: `Max-min chunk delta is ${(max - min)} of ${total} total chunks (${Math.round(imbalance * 100)}%, threshold ${Math.round(t.sharding_imbalance_percentage * 100)}%). Inspect the balancer / shard key — see https://www.mongodb.com/docs/manual/core/sharding-balancer/.`,
        });
      }
    }
  }

  const balancer = shardInfo.balancer_status;
  if (balancer && balancer.mode && balancer.mode !== "full") {
    findings.push({
      host: "cluster",
      severity: "MEDIUM",
      title: `Balancer mode is ${balancer.mode}`,
      description: "Balancer is not in `full` mode — chunks may not redistribute even when imbalance grows. Re-enable with `sh.startBalancer()`.",
    });
  }

  return findings;
}

module.exports = {
  id: "ShardKeyItem",
  label: "Sharding",
  run,
};
