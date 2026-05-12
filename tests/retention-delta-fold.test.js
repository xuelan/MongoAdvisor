const { test } = require("node:test");
const assert = require("node:assert/strict");

const { _internal } = require("../src/retention");
const { sumPositiveDeltas, floorToHour, addHours } = _internal;

test("sumPositiveDeltas: empty input returns 0", () => {
  assert.equal(sumPositiveDeltas([]), 0);
});

test("sumPositiveDeltas: non-array input returns 0", () => {
  assert.equal(sumPositiveDeltas(null), 0);
  assert.equal(sumPositiveDeltas(undefined), 0);
  assert.equal(sumPositiveDeltas("nope"), 0);
});

test("sumPositiveDeltas: single snapshot returns its value (treated as Δ from 0)", () => {
  // First snapshot in a series is the counter value so far — see the docstring
  // on sumPositiveDeltas. This is correct because the bucket inherits whatever
  // activity preceded it, attributed to this bucket's first observation.
  assert.equal(sumPositiveDeltas([42]), 42);
});

test("sumPositiveDeltas: monotonic growth folds to (first + (last - first))", () => {
  // [10, 12, 15, 20] → first=10, then deltas 2, 3, 5 → total = 10+2+3+5 = 20
  assert.equal(sumPositiveDeltas([10, 12, 15, 20]), 20);
});

test("sumPositiveDeltas: counter reset starts a new series", () => {
  // [10, 12, 4, 7] → first=10, +2, reset adds 4 as new first, +3 → 10+2+4+3 = 19
  assert.equal(sumPositiveDeltas([10, 12, 4, 7]), 19);
});

test("sumPositiveDeltas: repeated resets are each absorbed correctly", () => {
  // [5, 3, 8, 2]
  //   start  → +5  (total=5,  prev=5)
  //   3<5    → +3  (total=8,  prev=3)   [reset]
  //   8>=3   → +5  (total=13, prev=8)
  //   2<8    → +2  (total=15, prev=2)   [reset]
  assert.equal(sumPositiveDeltas([5, 3, 8, 2]), 15);
});

test("sumPositiveDeltas: non-numeric entries are skipped", () => {
  // 'NaN' values shouldn't break the fold; they should just be ignored.
  assert.equal(sumPositiveDeltas([10, "oops", 12]), 12,
    "skip the bad value and continue the series: 10 + (12 - 10) = 12");
});

test("sumPositiveDeltas: equal consecutive values contribute zero delta", () => {
  assert.equal(sumPositiveDeltas([7, 7, 7]), 7, "idle counter — first only");
});

test("floorToHour: snaps to the start of the hour in UTC", () => {
  const d = new Date("2026-05-11T14:37:42.123Z");
  const floored = floorToHour(d);
  assert.equal(floored.toISOString(), "2026-05-11T14:00:00.000Z");
});

test("addHours: forward and backward arithmetic preserves milliseconds", () => {
  const d = new Date("2026-05-11T14:00:00.000Z");
  assert.equal(addHours(d, 3).toISOString(), "2026-05-11T17:00:00.000Z");
  assert.equal(addHours(d, -2).toISOString(), "2026-05-11T12:00:00.000Z");
  assert.equal(addHours(d, 0).toISOString(), d.toISOString());
});

test("addHours: crosses day boundary correctly", () => {
  const d = new Date("2026-05-11T22:00:00.000Z");
  assert.equal(addHours(d, 5).toISOString(), "2026-05-12T03:00:00.000Z");
});
