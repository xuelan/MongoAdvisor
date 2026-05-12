/**
 * IndexInfoItem — index hygiene:
 *   - unused indexes: 0 accesses since `unused_index_days` ago
 *   - too many indexes on a single collection (> `num_indexes`)
 *   - redundant: index key is a strict prefix of another key on the same collection
 */

const SYS_DB_NAMES = new Set(["admin", "config", "local"]);

function indexKeyString(key) {
  if (!key) return "";
  return Object.entries(key)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

function isPrefixOf(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length >= kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

function parseSince(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date(value).getTime();
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function run(report, thresholds) {
  const t = thresholds?.IndexInfoItem || {};
  const unusedMs = (t.unused_index_days || 7) * 86400 * 1000;
  const findings = [];

  for (const node of report.nodes) {
    if (node.role === "MONGOS") continue;
    const dbs = node.normalized?.databases || [];
    const captureMs = parseSince(node.normalized?.capturedAt) || Date.now();

    for (const db of dbs) {
      if (SYS_DB_NAMES.has(db.name)) continue;
      for (const coll of db.collections) {
        const ns = `${db.name}.${coll.name}`;
        const idxs = coll.indexes || [];

        if (t.num_indexes && idxs.length > t.num_indexes) {
          findings.push({
            host: node.host,
            severity: "MEDIUM",
            title: `${idxs.length} indexes on ${ns}`,
            description: `Above the ${t.num_indexes}-index threshold. Each extra index slows writes and bloats storage — audit usage with \`$indexStats\` and drop the ones that aren't needed.`,
          });
        }

        // Redundancy (prefix-of) — pure-key relationship, no usage data needed.
        for (let i = 0; i < idxs.length; i++) {
          for (let j = 0; j < idxs.length; j++) {
            if (i === j) continue;
            const a = idxs[i];
            const b = idxs[j];
            if (!a.key || !b.key) continue;
            if (isPrefixOf(a.key, b.key)) {
              findings.push({
                host: node.host,
                severity: "LOW",
                title: `Redundant index ${a.name} on ${ns}`,
                description: `Key {${indexKeyString(a.key)}} is a strict prefix of {${indexKeyString(b.key)}} (\`${b.name}\`). Drop the shorter one to save write cost and storage.`,
              });
              break; // one finding per index is enough
            }
          }
        }

        // Unused — at least one host reports 0 ops AND the index is older than the threshold.
        const stats = coll.indexStats || [];
        for (const entry of stats) {
          const name = entry?.key ? indexKeyString(entry.key) : "(unknown key)";
          const hosts = entry?.stats || [];
          for (const h of hosts) {
            const ops = Number(h.accesses || 0);
            const since = parseSince(h.since);
            if (ops === 0 && since && captureMs - since > unusedMs) {
              const ageDays = Math.round((captureMs - since) / 86400000);
              findings.push({
                host: h.host || node.host,
                severity: "LOW",
                title: `Unused index {${name}} on ${ns}`,
                description: `Zero \`$indexStats\` accesses on ${h.host || node.host} since ${new Date(since).toISOString()} (${ageDays} days). Hide first (\`collMod\`), drop after one business cycle.`,
              });
            }
          }
        }
      }
    }
  }
  return findings;
}

module.exports = {
  id: "IndexInfoItem",
  label: "Indexes",
  run,
};
