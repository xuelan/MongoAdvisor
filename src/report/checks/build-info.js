/**
 * BuildInfoItem — flag MongoDB versions older than `eol_version`.
 * Default floor is 4.4.0 (anything below has reached end of life).
 */

function compareVersions(a, b) {
  const pa = String(a)
    .split(".")
    .map((s) => parseInt(s, 10) || 0);
  const pb = b.map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function run(report, thresholds) {
  const eol = thresholds?.BuildInfoItem?.eol_version || [4, 4, 0];
  const findings = [];
  for (const node of report.nodes) {
    const version =
      node.normalized?.server?.serverStatus?.version ||
      node.normalized?.server?.buildInfo?.version;
    if (!version) continue;
    if (compareVersions(version, eol) < 0) {
      findings.push({
        host: node.host,
        severity: "HIGH",
        title: `MongoDB ${version} is end of life`,
        description: `Server reports version ${version}, which is older than the EOL floor ${eol.join(".")}. Upgrade to a supported release — see https://www.mongodb.com/legal/support-policy/lifecycles.`,
      });
    }
  }
  return findings;
}

module.exports = {
  id: "BuildInfoItem",
  label: "Build info",
  run,
};
