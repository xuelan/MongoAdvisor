/**
 * Group multiple parsed getMongoData captures (one per machine) into a single logical report.
 *
 * Rules:
 *  - Same `setName` → same replica set → same group, distinct nodes.
 *  - `topology === "mongos"` → top-level mongos entry; if shard sub-RSes are also uploaded
 *    in the same batch, they become siblings under the same report.
 *  - Standalone or unknown topology with no setName → each file is its own group.
 *  - Mixed `setName`s in one upload → the report is marked `topology: "mixed"` and every
 *    distinct setName becomes a node group; checks run per-node and findings include the
 *    `host` so the user can still tell who reported what.
 */

function nodeFromNormalized(parsed, fileMeta) {
  const ss = parsed.server?.serverStatus || {};
  const im = parsed.ismaster || {};
  const isMongos = parsed.topology === "mongos";
  let role = "UNKNOWN";
  if (isMongos) role = "MONGOS";
  else if (im.ismaster || im.isWritablePrimary) role = "PRIMARY";
  else if (im.secondary) role = "SECONDARY";
  else if (im.arbiterOnly) role = "ARBITER";

  return {
    host: ss.host || im.me || parsed.reportedHost || fileMeta?.name || "unknown",
    isMongos,
    role,
    version: ss.version || parsed.server?.buildInfo?.version || null,
    processName: ss.process || null,
    setName: parsed.setName || null,
    file: fileMeta || null,
    normalized: parsed,
  };
}

function group(parsedFiles) {
  const groups = new Map();

  for (const { parsed, file } of parsedFiles) {
    const node = nodeFromNormalized(parsed, file);
    const key = node.setName || node.host || file?.name || "standalone";
    if (!groups.has(key)) {
      groups.set(key, {
        setName: node.setName,
        topologyHint: parsed.topology,
        nodes: [],
      });
    }
    groups.get(key).nodes.push(node);
  }

  const groupArr = Array.from(groups.values());

  let topology;
  if (groupArr.length === 1) {
    topology = groupArr[0].topologyHint;
  } else if (groupArr.some((g) => g.topologyHint === "mongos")) {
    topology = "sharded";
  } else if (groupArr.every((g) => g.topologyHint === "replicaSet")) {
    topology = "mixed";
  } else {
    topology = "mixed";
  }

  // Choose a primary setName / display name. Prefer a real replica-set name; otherwise
  // the first reported host. For mongos captures, use the mongos's setName guess
  // ("config" set isn't tracked in v1).
  const setName =
    groupArr.find((g) => g.setName)?.setName ||
    groupArr[0]?.nodes[0]?.host ||
    null;

  return {
    topology,
    setName,
    groups: groupArr,
    /** Flat list — convenient for checks that iterate per-node. */
    nodes: groupArr.flatMap((g) => g.nodes),
  };
}

module.exports = { group, nodeFromNormalized };
