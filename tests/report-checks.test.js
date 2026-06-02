const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parse, normalize } = require("../src/report/parser");
const { group } = require("../src/report/grouper");
const { runAll, summarize } = require("../src/report/checks");
const clusterCheck = require("../src/report/checks/cluster");

// See tests/report-parser.test.js for fixture conventions. Tests that need the fixture
// skip gracefully when it's not present.
const CANDIDATES = [
  process.env.MONGOADVISOR_SAMPLE,
  path.join(__dirname, "..", "tmp", "getMongoData-replicaset.json"),
  path.join(__dirname, "..", "tmp", "getMongoData-1049.js"),
].filter(Boolean);
const SAMPLE = CANDIDATES.find((p) => fs.existsSync(p)) || null;
const SKIP_MSG = "skipping fixture-driven test: no getMongoData sample found under tmp/";

function loadReport() {
  const sections = parse(fs.readFileSync(SAMPLE, "utf8"));
  const normalized = normalize(sections);
  return group([{ parsed: normalized, file: { name: "sample.json", size: 0 } }]);
}

test("runAll returns findings array with required fields", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const report = loadReport();
  const findings = runAll(report);
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.ok(f.id, "finding has id");
    assert.ok(f.item, "finding has item label");
    assert.ok(f.severity, "finding has severity");
    assert.ok(f.title, "finding has title");
    assert.ok(f.description, "finding has description");
    assert.ok(["HIGH", "MEDIUM", "LOW", "INFO"].includes(f.severity));
  }
});

test("BuildInfoItem does NOT flag a supported server version", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  // Sample is on a supported major (>= 4.4); BuildInfoItem should not fire.
  const findings = runAll(loadReport());
  const buildFindings = findings.filter((f) => f.id === "BuildInfoItem");
  assert.equal(buildFindings.length, 0, "supported server version should not trigger EOL warning");
});

test("SecurityItem does NOT flag a properly-configured node", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  // Sample is a mongod with auth=enabled, TLS=requireTLS; only the JS-engine info
  // finding may appear.
  const findings = runAll(loadReport()).filter((f) => f.id === "SecurityItem");
  for (const f of findings) {
    assert.ok(!/Authentication is not enabled/i.test(f.title), `unexpected: ${f.title}`);
    assert.ok(!/TLS is not required/i.test(f.title), `unexpected: ${f.title}`);
  }
});

test("ClusterItem reports oplog window when below threshold", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  // Sample's info.timeDiffHours is well below the default 48h floor → expect a finding.
  const findings = runAll(loadReport()).filter((f) => f.id === "ClusterItem");
  assert.ok(
    findings.some((f) => /oplog window/i.test(f.title)),
    "small oplog window should trigger a ClusterItem finding",
  );
});

test("ClusterItem Atlas oplog guidance links docs without CLI or API snippets", () => {
  const findings = clusterCheck.run({
    groups: [
      {
        setName: "atlas-example",
        nodes: [
          {
            host: "cluster0-shard-00-00.abc.mongodb.net:27017",
            normalized: {
              replicaSet: {
                status: {
                  members: [
                    {
                      name: "cluster0-shard-00-00.abc.mongodb.net:27017",
                      stateStr: "PRIMARY",
                      optimeDate: "2026-01-01T00:00:00.000Z",
                    },
                  ],
                },
                info: {
                  timeDiffHours: 6,
                  logSizeMB: 1000,
                  usedMB: 500,
                },
              },
            },
          },
        ],
      },
    ],
  }, { ClusterItem: { oplog_window_hours: 48 } });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].platform, "atlas");
  assert.equal(findings[0].actions.length, 0);
  assert.equal(
    findings[0].docs,
    "https://www.mongodb.com/docs/atlas/customize-storage/#std-label-oplog-size-behavior/",
  );
  assert.match(findings[0].description, /storage auto-scaling/i);
  assert.doesNotMatch(findings[0].description, /Atlas CLI|Admin API|Additional Settings|UI path/i);
});

test("summarize aggregates counts by severity", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const findings = runAll(loadReport());
  const sum = summarize(findings);
  assert.ok(sum.total === findings.length);
  assert.ok(sum.bySeverity && typeof sum.bySeverity.HIGH === "number");
  const sumOfSeverities = Object.values(sum.bySeverity).reduce((a, b) => a + b, 0);
  assert.equal(sumOfSeverities, findings.length);
});

test("buggy check is reported as a finding, not a crash", () => {
  const findings = runAll({ nodes: [], groups: [] });
  assert.ok(Array.isArray(findings));
});
