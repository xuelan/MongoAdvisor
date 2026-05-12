const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQueryStatsPipelinePrefix,
  buildSlowQueriesPipelinePrefix,
} = require("../src/routes/metrics");
const { rawHotCutoff, COLLECTIONS: RC } = require("../src/retention");

// Fixed reference: a date guaranteed to be older than rawHotCutoff() so the
// "since predates cutoff" branch fires deterministically regardless of when
// the suite runs.
function farPast() {
  return new Date("2020-01-01T00:00:00Z");
}

// A timestamp safely *after* rawHotCutoff() — used to exercise the hot-only
// fast path. Five seconds before "now" is well inside the 7-day raw window.
function inHotWindow() {
  return new Date(Date.now() - 5_000);
}

test("buildQueryStatsPipelinePrefix: hot-only fast path when since >= cutoff", () => {
  const filter = { clusterId: "X", timestamp: { $gte: inHotWindow() } };
  const pipeline = buildQueryStatsPipelinePrefix(filter);

  assert.equal(pipeline.length, 1, "should be a single $match stage");
  assert.deepEqual(pipeline[0], { $match: filter }, "$match should be the filter as-is");
});

test("buildQueryStatsPipelinePrefix: hybrid union when since < cutoff", () => {
  const since = farPast();
  const filter = { clusterId: "X", timestamp: { $gte: since } };
  const pipeline = buildQueryStatsPipelinePrefix(filter);

  assert.equal(pipeline.length, 2, "should be $match + $unionWith");

  // Raw branch: timestamp clamped forward to the hot cutoff
  const rawMatch = pipeline[0].$match;
  assert.ok(rawMatch.timestamp.$gte instanceof Date, "raw match $gte should be a Date");
  assert.ok(rawMatch.timestamp.$gte > since, "raw branch should start at cutoff, not since");
  assert.equal(rawMatch.clusterId, "X", "non-timestamp filter fields should be preserved");

  // Rollup branch: covers [since, cutoff)
  const union = pipeline[1].$unionWith;
  assert.equal(union.coll, RC.QUERY_STATS_HOURLY);
  const rollupMatch = union.pipeline[0].$match;
  assert.ok(rollupMatch.bucketStart.$gte instanceof Date);
  assert.equal(rollupMatch.bucketStart.$gte.getTime(), since.getTime(), "rollup $gte == since");
  assert.ok(rollupMatch.bucketStart.$lt instanceof Date, "rollup $lt is the cutoff");
  assert.equal(rollupMatch.bucketStart.$lt.getTime(), rawMatch.timestamp.$gte.getTime(),
    "rollup upper bound matches raw lower bound");
  assert.equal(rollupMatch.timestamp, undefined, "rollup branch should not keep a raw timestamp filter");
});

test("buildQueryStatsPipelinePrefix: ALL filter (since undefined) unions rollup for all history", () => {
  // This is the case that motivated the recent fix — the dashboard's "All"
  // button sends no `since`, and the old code silently dropped the rollup.
  const filter = { clusterId: "X" };
  const pipeline = buildQueryStatsPipelinePrefix(filter);

  assert.equal(pipeline.length, 2, "ALL filter should still produce a union, not raw-only");

  const rawMatch = pipeline[0].$match;
  assert.ok(rawMatch.timestamp?.$gte instanceof Date, "raw branch is bounded below by cutoff");

  const union = pipeline[1].$unionWith;
  assert.equal(union.coll, RC.QUERY_STATS_HOURLY);
  const rollupMatch = union.pipeline[0].$match;
  assert.equal(rollupMatch.bucketStart.$gte, undefined,
    "ALL filter: rollup branch has no lower bound (covers all history)");
  assert.ok(rollupMatch.bucketStart.$lt instanceof Date,
    "ALL filter: rollup branch is still capped above at the cutoff so raw + rollup don't overlap");
});

test("buildQueryStatsPipelinePrefix: rollup branch projects bucketStart → timestamp and aliases fields", () => {
  const pipeline = buildQueryStatsPipelinePrefix({ clusterId: "X", timestamp: { $gte: farPast() } });
  const project = pipeline[1].$unionWith.pipeline[1].$project;

  assert.equal(project.timestamp, "$bucketStart", "rollup bucketStart aliased as raw timestamp");
  assert.equal(project.queryShape, "$queryShapeSample", "rollup queryShapeSample aliased as raw queryShape");
  assert.equal(project.lastExecutionMicros, "$lastExecutionMicrosMax", "lastExecutionMicros aliased from rollup max");
  // Counters: kept under the same name so downstream $sum works without rewriting.
  for (const field of ["execCount", "totalExecMicros", "docsExamined", "keysExamined"]) {
    assert.equal(project[field], 1, `rollup ${field} is kept under the raw column name`);
  }
});

test("buildSlowQueriesPipelinePrefix: hot-only fast path tags raw rows with _weight=1", () => {
  const pipeline = buildSlowQueriesPipelinePrefix({ clusterId: "X", timestamp: { $gte: inHotWindow() } });

  assert.equal(pipeline.length, 2, "fast path should be $match + $addFields");
  const addFields = pipeline[1].$addFields;
  assert.equal(addFields._weight, 1, "raw row weight should always be 1");
  assert.equal(addFields._totalMillis, "$millis", "raw _totalMillis aliased from per-row millis");
  assert.equal(addFields._maxMillis, "$millis");
});

test("buildSlowQueriesPipelinePrefix: hybrid path emits aliased rollup branch", () => {
  const since = farPast();
  const pipeline = buildSlowQueriesPipelinePrefix({ clusterId: "X", timestamp: { $gte: since } });

  // [ $match, $addFields, $unionWith ]
  assert.equal(pipeline.length, 3, "hybrid path: raw match + tag + union");

  const union = pipeline[2].$unionWith;
  assert.equal(union.coll, RC.SLOW_QUERIES_HOURLY);
  const rollupProject = union.pipeline[1].$project;
  assert.equal(rollupProject._weight, "$count", "rollup weight is the bucket's event count");
  assert.equal(rollupProject._totalMillis, "$totalMillis", "rollup totalMillis from rollup field");
  assert.equal(rollupProject._maxMillis, "$maxMillis");
  assert.equal(rollupProject.millis, "$avgMillis",
    "rollup exposes avgMillis under `millis` for any legacy consumer");
});

test("buildSlowQueriesPipelinePrefix: ALL filter unions rollup for all history (no lower bucketStart bound)", () => {
  const pipeline = buildSlowQueriesPipelinePrefix({ clusterId: "X" });

  assert.equal(pipeline.length, 3, "ALL filter still produces hybrid pipeline");

  const rollupMatch = pipeline[2].$unionWith.pipeline[0].$match;
  assert.equal(rollupMatch.bucketStart.$gte, undefined,
    "ALL filter: no lower bound — entire rollup history is included");
  assert.ok(rollupMatch.bucketStart.$lt instanceof Date,
    "ALL filter: rollup capped at cutoff to avoid double counting with raw");
});

test("rawHotCutoff returns a Date roughly RAW_TTL_DAYS in the past", () => {
  const cutoff = rawHotCutoff();
  const ageMs = Date.now() - cutoff.getTime();
  // Default RETENTION_RAW_DAYS = 7 days. Allow a wide window so the test is
  // robust to env overrides; the important property is that it's at least 1 d
  // in the past (so we never confuse "hot only" with "no cutoff").
  assert.ok(ageMs >= 86_400_000, `rawHotCutoff (${cutoff.toISOString()}) should be at least 1 day in the past`);
});
