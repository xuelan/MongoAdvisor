const { test } = require("node:test");
const assert = require("node:assert/strict");

const { isHiddenTopLevelDb, HIDDEN_TOP_LEVEL_DBS } = require("../src/hidden-dbs");

test("isHiddenTopLevelDb hides the MongoDB system databases", () => {
  for (const sysDb of ["admin", "config", "local"]) {
    assert.equal(isHiddenTopLevelDb(sysDb), true, `${sysDb} must be hidden`);
  }
});

test("isHiddenTopLevelDb hides the MongoAdvisor app DB", () => {
  assert.equal(isHiddenTopLevelDb("mongoadvisor"), true);
});

test("isHiddenTopLevelDb hides the MCP scratch DB", () => {
  assert.equal(isHiddenTopLevelDb("#mongodb-mcp"), true);
});

test("isHiddenTopLevelDb is exact-match (case-sensitive)", () => {
  assert.equal(isHiddenTopLevelDb("ADMIN"), false, "uppercase variant is not hidden — Atlas db names are case-sensitive");
  assert.equal(isHiddenTopLevelDb("Admin"), false);
});

test("isHiddenTopLevelDb passes through workload DBs", () => {
  for (const userDb of ["sample_airbnb", "sample_mflix", "myApp", "users", "products"]) {
    assert.equal(isHiddenTopLevelDb(userDb), false, `${userDb} must be visible`);
  }
});

test("HIDDEN_TOP_LEVEL_DBS export stays in sync with isHiddenTopLevelDb", () => {
  for (const name of HIDDEN_TOP_LEVEL_DBS) {
    assert.equal(isHiddenTopLevelDb(name), true, `${name} is in HIDDEN_TOP_LEVEL_DBS but predicate returns false`);
  }
});

test("isHiddenTopLevelDb handles empty / null / undefined safely", () => {
  assert.equal(isHiddenTopLevelDb(""), false);
  assert.equal(isHiddenTopLevelDb(null), false);
  assert.equal(isHiddenTopLevelDb(undefined), false);
});
