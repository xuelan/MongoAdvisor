const { test } = require("node:test");
const assert = require("node:assert/strict");

const { _internal } = require("../src/discovery");
const { supportsQueryStats, QUERY_STATS_MIN_MAJOR, QUERY_STATS_MIN_MINOR } = _internal;

test("supportsQueryStats: constants are 7.1", () => {
  assert.equal(QUERY_STATS_MIN_MAJOR, 7);
  assert.equal(QUERY_STATS_MIN_MINOR, 1);
});

test("supportsQueryStats: 7.1 is supported (exact minimum)", () => {
  assert.equal(supportsQueryStats([7, 1, 0, 0]), true);
});

test("supportsQueryStats: 7.0 is NOT supported (below minimum)", () => {
  assert.equal(supportsQueryStats([7, 0, 9, 0]), false);
});

test("supportsQueryStats: 6.x is NOT supported", () => {
  assert.equal(supportsQueryStats([6, 0, 0, 0]), false);
  assert.equal(supportsQueryStats([6, 9, 0, 0]), false);
});

test("supportsQueryStats: 8.x is supported (major above minimum)", () => {
  assert.equal(supportsQueryStats([8, 0, 0, 0]), true);
});

test("supportsQueryStats: 7.2+ is supported", () => {
  assert.equal(supportsQueryStats([7, 2, 0, 0]), true);
  assert.equal(supportsQueryStats([7, 10, 0, 0]), true);
});

test("supportsQueryStats: missing or invalid versionArray returns null (unknown)", () => {
  // null = "we couldn't determine; don't gate on it"
  assert.equal(supportsQueryStats(null), null);
  assert.equal(supportsQueryStats(undefined), null);
  assert.equal(supportsQueryStats([]), null);
  assert.equal(supportsQueryStats("not-an-array"), null);
  assert.equal(supportsQueryStats([NaN, NaN]), null);
});

test("supportsQueryStats: handles missing minor (treats as 0)", () => {
  // versionArray with just [major] is unusual but the gate should be defensive.
  assert.equal(supportsQueryStats([7]), false, "[7] is 7.0 — below 7.1 floor");
  assert.equal(supportsQueryStats([8]), true,  "[8] is 8.0 — above floor");
});
