const { execFile } = require("child_process");
const path = require("path");

const ITERATIONS = 10;
const SCRIPTS = [
  { file: "workload-agg.js", label: "airbnb-analytics" },
  { file: "workload-agg2.js", label: "airbnb-seasonal" },
  { file: "workload-mflix.js", label: "mflix-pipelines" },
];

function runOnce(script, iteration) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = execFile(
      process.execPath,
      [path.join(__dirname, script.file)],
      { timeout: 300_000 },
      (err, stdout, stderr) => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const status = err ? "FAIL" : "OK";
        console.log(`  [${script.label}] run ${iteration}/${ITERATIONS} — ${status} in ${elapsed}s`);
        if (err && stderr) console.error(`    ${stderr.split("\n")[0]}`);
        resolve({ script: script.label, iteration, elapsed, status });
      },
    );
  });
}

async function main() {
  console.log(`Running ${SCRIPTS.length} workloads x ${ITERATIONS} iterations each (async)\n`);
  const globalStart = Date.now();

  const allTasks = [];
  for (const script of SCRIPTS) {
    for (let i = 1; i <= ITERATIONS; i++) {
      allTasks.push(runOnce(script, i));
    }
  }

  const results = await Promise.all(allTasks);

  const flat = results;
  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`All done in ${totalElapsed}s — ${flat.length} total runs\n`);

  for (const script of SCRIPTS) {
    const runs = flat.filter((r) => r.script === script.label);
    const ok = runs.filter((r) => r.status === "OK").length;
    const times = runs.map((r) => parseFloat(r.elapsed));
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
    const min = Math.min(...times).toFixed(1);
    const max = Math.max(...times).toFixed(1);
    console.log(`  ${script.label.padEnd(20)} ${ok}/${ITERATIONS} OK  avg=${avg}s  min=${min}s  max=${max}s`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
