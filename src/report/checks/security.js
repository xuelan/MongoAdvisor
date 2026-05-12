/**
 * SecurityItem — boolean checks against `command_line_info.parsed` and `server_parameters`.
 *
 * Covers auth enabled, TLS configured, server-side JS disabled, localhostAuthBypass off.
 * One finding is emitted per failed boolean per host so the user sees exactly which
 * mongod has the gap.
 */

function getCmd(node) {
  return node.normalized?.server?.cmdLine?.parsed || {};
}

function run(report) {
  const findings = [];
  for (const node of report.nodes) {
    if (node.role === "MONGOS") continue; // checks below are mongod-only signals
    const parsed = getCmd(node);
    const sec = parsed.security || {};
    const net = parsed.net || {};

    const auth = sec.authorization;
    if (auth && auth !== "enabled") {
      findings.push({
        host: node.host,
        severity: "HIGH",
        title: "Authentication is not enabled",
        description:
          "`security.authorization` is not set to `enabled`. Configure SCRAM / x509 / LDAP and require it cluster-wide before exposing the deployment.",
      });
    } else if (!auth) {
      findings.push({
        host: node.host,
        severity: "HIGH",
        title: "Authentication is not configured",
        description:
          "No `security.authorization` was found in the command-line config. Verify that auth is enabled or this node will accept any connection.",
      });
    }

    const tls = net.tls || net.ssl;
    if (!tls || (tls.mode && /^(disabled|allowTLS)$/i.test(tls.mode))) {
      findings.push({
        host: node.host,
        severity: "HIGH",
        title: "TLS is not required",
        description:
          "`net.tls.mode` is not `requireTLS` (or TLS is absent from the config). Require TLS to prevent unencrypted client traffic.",
      });
    }

    if (sec.javascriptEnabled === true) {
      findings.push({
        host: node.host,
        severity: "LOW",
        title: "Server-side JavaScript is enabled",
        description:
          "`security.javascriptEnabled` is true. Disable it unless `$where` / `mapReduce` is actually needed; it broadens the attack surface.",
      });
    }

    const params = node.normalized?.server?.parameters || {};
    if (params.enableLocalhostAuthBypass === 1 || params.enableLocalhostAuthBypass === true) {
      findings.push({
        host: node.host,
        severity: "MEDIUM",
        title: "Localhost auth bypass is enabled",
        description:
          "`enableLocalhostAuthBypass` is on. Once the deployment has any user, set this to 0 (`setParameter`) so the bypass cannot be re-armed.",
      });
    }
  }
  return findings;
}

module.exports = {
  id: "SecurityItem",
  label: "Security",
  run,
};
