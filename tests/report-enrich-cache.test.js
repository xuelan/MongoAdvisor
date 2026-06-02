const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { enrichNormalizedCache, cacheBytesByNsFromRaw } = require("../src/report/enrich-cache");
const { buildSelfContained } = require("../src/report/html-builder");

const SAMPLE = path.join(__dirname, "..", "tmp", "getMongoData-replicaset.json");

test("enrichNormalizedCache fills wiredTiger.cache from raw getMongoData", { skip: fs.existsSync(SAMPLE) ? false : "no sample" }, () => {
  const raw = fs.readFileSync(SAMPLE, "utf8");
  const report = {
    normalized: [
      {
        normalized: {
          databases: [
            {
              name: "test",
              collections: [
                {
                  name: "restaurants",
                  stats: {
                    ns: "test.restaurants",
                    wiredTiger: { "block-manager": { "file bytes available for reuse": 1 } },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const map = cacheBytesByNsFromRaw([raw]);
  assert.ok(map.size > 0, "raw sample should expose collection cache bytes");
  const [ns, bytes] = map.entries().next().value;
  report.normalized[0].normalized.databases[0].collections[0].stats.ns = ns;
  const enriched = enrichNormalizedCache(report, [raw]);
  const wt = enriched.normalized[0].normalized.databases[0].collections[0].stats.wiredTiger;
  assert.equal(wt.cache?.["bytes currently in the cache"], bytes);
});

test("buildSelfContained embeds collection cache after enrich", { skip: fs.existsSync(SAMPLE) ? false : "no sample" }, () => {
  const raw = fs.readFileSync(SAMPLE, "utf8");
  const [ns, bytes] = cacheBytesByNsFromRaw([raw]).entries().next().value;
  const [dbName, collName] = ns.split(".");
  const report = {
    _id: "test",
    name: "sample",
    normalized: [
      {
        normalized: {
          databases: [
            {
              name: dbName,
              collections: [
                {
                  name: collName,
                  stats: {
                    ns,
                    wiredTiger: { "block-manager": { "file bytes available for reuse": 100 } },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    findings: [],
    summary: {},
  };
  const html = buildSelfContained(report, { rawEjsonTexts: [raw] });
  const m = html.match(/<script[^>]*id="reportData"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "reportData script present");
  const embedded = JSON.parse(m[1]);
  const coll = embedded.normalized[0].normalized.databases[0].collections[0].stats;
  assert.equal(coll.wiredTiger?.cache?.["bytes currently in the cache"], bytes);
});
