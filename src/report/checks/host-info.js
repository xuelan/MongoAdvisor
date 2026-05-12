/**
 * HostInfoItem — OS / hardware sanity checks against `server_info.host_info`.
 *
 * Covers NUMA enabled, low RAM, low ulimit. These are emitted as MEDIUM findings —
 * they don't necessarily break SLOs but are common production-readiness gaps.
 */

const MIN_RAM_GB = 8;
const MIN_MAX_OPEN_FILES = 64000;

function run(report) {
  const findings = [];
  for (const node of report.nodes) {
    const hi = node.normalized?.server?.hostInfo;
    if (!hi) continue;

    const memMb = Number(hi.system?.memSizeMB || hi.system?.memLimitMB || 0);
    if (memMb > 0 && memMb < MIN_RAM_GB * 1024) {
      findings.push({
        host: node.host,
        severity: "MEDIUM",
        title: `Host RAM is ${(memMb / 1024).toFixed(1)} GB`,
        description: `MongoDB recommends at least ${MIN_RAM_GB} GB of RAM for production replica-set members. Verify cache-size tuning if this is intentional.`,
      });
    }

    if (hi.system?.numaEnabled === true && (hi.system?.numNumaNodes || 0) > 1) {
      findings.push({
        host: node.host,
        severity: "MEDIUM",
        title: "NUMA is enabled and unpinned",
        description:
          "MongoDB should be started with `numactl --interleave=all` on NUMA hosts to avoid memory access penalties. See https://www.mongodb.com/docs/manual/administration/production-checklist-operations/#numa.",
      });
    }

    const maxOpen = Number(hi.extra?.maxOpenFiles || 0);
    if (maxOpen > 0 && maxOpen < MIN_MAX_OPEN_FILES) {
      findings.push({
        host: node.host,
        severity: "MEDIUM",
        title: `ulimit -n is low (${maxOpen})`,
        description: `Recommended max open files is ${MIN_MAX_OPEN_FILES}+. Low limits cause connection-storm outages under load. See https://www.mongodb.com/docs/manual/reference/ulimit/.`,
      });
    }

    if (hi.os?.type && hi.os.type !== "Linux") {
      findings.push({
        host: node.host,
        severity: "LOW",
        title: `Non-Linux host detected (${hi.os.type})`,
        description:
          "MongoDB is supported on Linux for production. macOS / Windows hosts are fine for development but not for production deployments.",
      });
    }
  }
  return findings;
}

module.exports = {
  id: "HostInfoItem",
  label: "Host info",
  run,
};
