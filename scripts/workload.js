const { execFile } = require("child_process");
const path = require("path");

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const BASE_ITERATIONS = parseInt(process.argv[2]) || 10;
const DURATION_MS = parseInt(process.env.DURATION_MS || "0", 10);
const SCRIPTS = [
  { file: "workload-agg.js", label: "airbnb_listings_host_lookup_group" },
  { file: "workload-agg2.js", label: "airbnb_reviews_unwind_season_rollups" },
  { file: "workload-mflix.js", label: "mflix_agg_find_workloads" },
];

const READ_PREFS = ["primary", "secondary"];

function runOnce(script, iteration, totalIter) {
  return new Promise((resolve) => {
    const pref = READ_PREFS[rand(0, READ_PREFS.length - 1)];
    const start = Date.now();
    execFile(
      process.execPath,
      [path.join(__dirname, script.file)],
      { timeout: 300_000, env: { ...process.env, READ_PREF: pref } },
      (err, _stdout, stderr) => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const status = err ? "FAIL" : "OK";
        const label = totalIter ? `${iteration}/${totalIter}` : `${iteration}`;
        console.log(`  [${script.label}] run ${label} — ${status} in ${elapsed}s  (${pref})`);
        if (err && stderr) console.error(`    ${stderr.split("\n")[0]}`);
        resolve({ script: script.label, iteration, elapsed, status, totalIter, pref });
      },
    );
  });
}

function printSummary(perScript, results, totalElapsed) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`All done in ${totalElapsed}s — ${results.length} total runs\n`);
  for (const script of perScript) {
    const runs = results.filter((r) => r.script === script.label);
    if (!runs.length) {
      console.log(`  ${script.label.padEnd(20)} 0 runs`);
      continue;
    }
    const ok = runs.filter((r) => r.status === "OK").length;
    const times = runs.map((r) => parseFloat(r.elapsed));
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
    const min = Math.min(...times).toFixed(1);
    const max = Math.max(...times).toFixed(1);
    console.log(`  ${script.label.padEnd(20)} ${ok}/${runs.length} OK  avg=${avg}s  min=${min}s  max=${max}s`);
  }
}

async function runDurationLoop(script, deadline, results) {
  let i = 0;
  await sleep(rand(0, 1500));
  while (Date.now() < deadline) {
    i++;
    const res = await runOnce(script, i, 0);
    results.push(res);
    if (Date.now() >= deadline) break;
    await sleep(rand(250, 2000));
  }
}

async function main() {
  const globalStart = Date.now();

  if (DURATION_MS > 0) {
    const deadline = globalStart + DURATION_MS;
    console.log(`Running ${SCRIPTS.length} workloads in parallel for ${(DURATION_MS / 1000).toFixed(0)}s\n`);
    for (const s of SCRIPTS) console.log(`  ${s.label}`);
    console.log();

    const results = [];
    await Promise.all(SCRIPTS.map((s) => runDurationLoop(s, deadline, results)));

    const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
    printSummary(SCRIPTS, results, totalElapsed);
    return;
  }

  const iterPerScript = SCRIPTS.map((s) => {
    const n = rand(Math.max(1, BASE_ITERATIONS - 3), BASE_ITERATIONS + 3);
    return { ...s, iterations: n };
  });

  const totalRuns = iterPerScript.reduce((s, x) => s + x.iterations, 0);
  console.log(`Running ${SCRIPTS.length} workloads (${totalRuns} total runs, randomized)\n`);
  for (const s of iterPerScript) console.log(`  ${s.label}: ${s.iterations} iterations`);
  console.log();

  const allTasks = [];
  for (const script of iterPerScript) {
    for (let i = 1; i <= script.iterations; i++) {
      const delay = rand(0, 3000);
      allTasks.push(sleep(delay).then(() => runOnce(script, i, script.iterations)));
    }
  }

  const results = await Promise.all(allTasks);
  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  printSummary(iterPerScript, results, totalElapsed);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
