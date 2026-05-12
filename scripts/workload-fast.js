#!/usr/bin/env node
/**
 * Fast-workload orchestrator.
 *
 * Spawns N parallel long-running workers, each with its own connection pool,
 * that drive sustained index-backed traffic against the monitored cluster.
 * Two worker flavors:
 *
 *   workload-mflix-fast.js   – pure finds (cast/genres/runtime/email/geo/text)
 *   workload-fast-agg.js     – aggregation pipelines on airbnb_big + mflix
 *
 * Unlike `workload.js <iterations>` (which forks one short-lived child per
 * iteration and quickly exhausts file descriptors / sockets), this orchestrator
 * keeps a small fixed pool of workers alive for the configured duration.
 *
 *   node scripts/workload-fast.js [parallelism] [durationSec]
 *
 *     parallelism  default 5     concurrent worker processes
 *     durationSec  default 300   wall-time each worker runs (then exits)
 *
 *   Worker mix (env WORKLOAD_MIX):
 *     both   default — half mflix-fast (finds) + half workload-fast-agg
 *     mflix  only mflix-fast finds workers
 *     agg    only workload-fast-agg aggregation workers
 *
 *   Env vars passed through to children:
 *     MIN_SLEEP_MS, MAX_SLEEP_MS   sleep between ops in each worker
 *                                  (find default 80–350; agg default 100–400)
 *     MAX_TIME_MS                  per-op cap
 *     READ_PREF                    primary | secondary (default: random/worker)
 *     WORKLOAD_MONGO_URI / MONGO_URI
 *
 *   Examples:
 *     node scripts/workload-fast.js                          # 5 workers × 5 min, mixed
 *     node scripts/workload-fast.js 10 600                   # 10 workers × 10 min, mixed
 *     WORKLOAD_MIX=agg node scripts/workload-fast.js 8 1800  # all aggregations
 *     MIN_SLEEP_MS=0 MAX_SLEEP_MS=20 \
 *       node scripts/workload-fast.js 8 1800                 # dense load
 *
 * Each worker reports its own per-template breakdown; the orchestrator rolls
 * up `Total queries: …` lines into a final summary with overall ops/sec.
 */
const { spawn } = require("child_process");
const path = require("path");

const DEFAULT_PARALLELISM = 5;
const DEFAULT_DURATION_SEC = 300;

const WORKER_SCRIPTS = {
  mflix: path.join(__dirname, "workload-mflix-fast.js"),
  agg:   path.join(__dirname, "workload-fast-agg.js"),
};

function parseArgs() {
  const a = process.argv.slice(2);
  const parallelism = parseInt(a[0] || `${DEFAULT_PARALLELISM}`, 10);
  const durationSec = parseInt(a[1] || `${DEFAULT_DURATION_SEC}`, 10);
  if (!(parallelism > 0) || !(durationSec > 0)) {
    console.error("Usage: node scripts/workload-fast.js [parallelism] [durationSec]");
    process.exit(1);
  }
  const mix = (process.env.WORKLOAD_MIX || "both").toLowerCase();
  if (!["mflix", "agg", "both"].includes(mix)) {
    console.error(`Invalid WORKLOAD_MIX="${mix}" (expected mflix | agg | both)`);
    process.exit(1);
  }
  return { parallelism, durationSec, mix };
}

/**
 * Decide how to label each worker slot (mflix vs agg) given the requested mix.
 * For `both`, alternate so half are finds and half are aggregations. With odd
 * parallelism the extra slot goes to mflix (finds are lighter weight).
 */
function planWorkerKinds(parallelism, mix) {
  if (mix === "mflix") return Array(parallelism).fill("mflix");
  if (mix === "agg")   return Array(parallelism).fill("agg");
  // mix === "both": alternate so workers come up interleaved
  const out = [];
  for (let i = 0; i < parallelism; i++) {
    out.push(i % 2 === 0 ? "mflix" : "agg");
  }
  return out;
}

function spawnWorker(workerId, kind, durationMs) {
  return new Promise((resolve) => {
    const script = WORKER_SCRIPTS[kind];
    const env = {
      ...process.env,
      DURATION_MS: String(durationMs),
    };
    const child = spawn(process.execPath, [script], { env });

    let totalQueries = null;
    let lastTemplateLine = "";
    let stderrTail = "";
    let buf = "";

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        process.stdout.write(`  [w${workerId}/${kind}] ${line}\n`);
        const m = line.match(/^Total queries:\s*(\d+)/);
        if (m) totalQueries = parseInt(m[1], 10);
        if (/run \d+\s+\d+ms/.test(line)) lastTemplateLine = line;
      }
    });

    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-500);
      process.stderr.write(`  [w${workerId}/${kind} stderr] ${s.replace(/\n$/, "").replace(/\n/g, `\n  [w${workerId}/${kind} stderr] `)}\n`);
    });

    child.on("close", (code) => {
      resolve({
        workerId,
        kind,
        exitCode: code,
        totalQueries,
        lastTemplateLine,
        stderrTail: stderrTail.trim() || null,
      });
    });
  });
}

async function main() {
  const { parallelism, durationSec, mix } = parseArgs();
  const durationMs = durationSec * 1000;
  const kinds = planWorkerKinds(parallelism, mix);
  const kindCounts = kinds.reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc; }, {});

  console.log(
    `Fast-workload orchestrator: ${parallelism} parallel workers × ${durationSec}s ` +
    `(mix=${mix}, ${Object.entries(kindCounts).map(([k, v]) => `${v}×${k}`).join(" + ")})`,
  );
  console.log(
    `  MIN_SLEEP_MS=${process.env.MIN_SLEEP_MS || "default"}  MAX_SLEEP_MS=${process.env.MAX_SLEEP_MS || "default"}  ` +
    `READ_PREF=${process.env.READ_PREF || "(random per worker)"}`,
  );
  console.log(`  Worker scripts: ${Object.values(WORKER_SCRIPTS).map((p) => path.basename(p)).join(", ")}\n`);

  const startWall = Date.now();
  const workers = kinds.map((kind, i) => spawnWorker(i + 1, kind, durationMs));

  const results = await Promise.all(workers);
  const elapsedSec = (Date.now() - startWall) / 1000;

  const okWorkers   = results.filter((r) => r.exitCode === 0);
  const failWorkers = results.filter((r) => r.exitCode !== 0);
  const totalOps    = results.reduce((s, r) => s + (r.totalQueries || 0), 0);
  const opsPerSec   = totalOps / elapsedSec;

  // Per-kind throughput so user can see how aggregations vs finds compared.
  const perKind = {};
  for (const r of results) {
    if (!perKind[r.kind]) perKind[r.kind] = { ops: 0, ok: 0, fail: 0 };
    perKind[r.kind].ops += r.totalQueries || 0;
    if (r.exitCode === 0) perKind[r.kind].ok += 1; else perKind[r.kind].fail += 1;
  }

  console.log(`\n${"━".repeat(72)}`);
  console.log(`Fast-workload run done in ${elapsedSec.toFixed(1)}s`);
  console.log(`  workers              ${okWorkers.length}/${parallelism} OK` +
    (failWorkers.length ? `  (${failWorkers.length} failed)` : ""));
  console.log(`  total queries        ${totalOps.toLocaleString()}`);
  console.log(`  aggregate throughput ${opsPerSec.toFixed(1)} ops/sec`);
  for (const [k, v] of Object.entries(perKind)) {
    console.log(`    ${k.padEnd(6)} ${v.ok}/${v.ok + v.fail} OK  ${v.ops.toLocaleString()} ops  ${(v.ops / elapsedSec).toFixed(1)} ops/sec`);
  }
  console.log(`${"━".repeat(72)}`);

  if (failWorkers.length) {
    console.log("\nFailed workers:");
    for (const r of failWorkers) {
      console.log(`  w${r.workerId}/${r.kind}: exit=${r.exitCode}  stderr_tail=${r.stderrTail || "(empty)"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
