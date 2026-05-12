const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parse, normalize } = require("../src/report/parser");

// The sample is intentionally NOT committed (it's a real getMongoData dump and may contain
// customer-identifying details). Drop a file at any of the paths below — or set
// MONGOADVISOR_SAMPLE — to enable the fixture-driven tests. Without it, those tests skip.
const CANDIDATES = [
  process.env.MONGOADVISOR_SAMPLE,
  path.join(__dirname, "..", "tmp", "getMongoData-replicaset.json"),
  path.join(__dirname, "..", "tmp", "getMongoData-1049.js"),
].filter(Boolean);
const SAMPLE = CANDIDATES.find((p) => fs.existsSync(p)) || null;
const SKIP_MSG = "skipping fixture-driven test: no getMongoData sample found under tmp/";

function loadSample() {
  return parse(fs.readFileSync(SAMPLE, "utf8"));
}

test("parser reads the sample as an EJSON array of section docs", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const sections = loadSample();
  assert.ok(Array.isArray(sections));
  assert.ok(sections.length > 0);
  assert.equal(sections[0].section, "server_info");
  assert.equal(sections[0].subsection, "shell_version");
});

test("normalize extracts server / hostInfo / cmdLine / parameters", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const sections = loadSample();
  const r = normalize(sections);
  assert.ok(r.server.serverStatus);
  assert.equal(r.server.serverStatus.process, "mongod");
  assert.ok(/^\d+\.\d+\.\d+/.test(r.server.serverStatus.version));
  assert.ok(r.server.hostInfo?.system?.numCores > 0);
  assert.ok(r.server.cmdLine?.parsed);
  assert.ok(r.server.parameters);
});

test("normalize detects replica-set topology and set name", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const r = normalize(loadSample());
  assert.equal(r.topology, "replicaSet");
  assert.ok(typeof r.setName === "string" && r.setName.length > 0);
});

test("normalize groups data_info entries into databases and collections", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const r = normalize(loadSample());
  assert.ok(Array.isArray(r.databases));
  assert.ok(r.databases.length > 0, "sample has at least one database");
  const userDb = r.databases.find((d) => d.name.toLowerCase() !== "admin" && d.collections.length > 0);
  assert.ok(userDb, "sample has at least one non-admin database with collections");
  for (const c of userDb.collections) {
    assert.ok(c.stats, `${c.name} has stats`);
    assert.ok(Array.isArray(c.indexes), `${c.name} has indexes array`);
    assert.ok(c.indexes.length >= 1, `${c.name} has at least _id index`);
  }
});

test("normalize captures replica-set members from rs.status()", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const r = normalize(loadSample());
  const status = r.replicaSet?.status;
  assert.ok(status?.members?.length >= 1, "sample has at least one rs member");
  assert.ok(status.members.some((m) => m.stateStr === "PRIMARY"), "one member is PRIMARY");
});

test("normalize survives missing sections (graceful when a section is absent)", { skip: SAMPLE ? false : SKIP_MSG }, () => {
  const r = normalize(loadSample());
  assert.ok(r.drivers === null || Array.isArray(r.drivers));
});

test("normalize returns nulls for a heavily-stripped input", () => {
  const r = normalize([
    { section: "server_info", subsection: "server_status_info", output: { host: "x", version: "7.0.31", process: "mongod" } },
    { section: "shard_or_replicaset_info", subsection: "ismaster", output: { setName: "rs0", ismaster: true } },
  ]);
  assert.equal(r.topology, "replicaSet");
  assert.equal(r.setName, "rs0");
  assert.equal(r.server.hostInfo, null);
  assert.equal(r.replicaSet, null);
  assert.deepEqual(r.databases, []);
});
