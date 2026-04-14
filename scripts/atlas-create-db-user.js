#!/usr/bin/env node
/**
 * Create an Atlas database user via the Atlas Administration API (Digest auth).
 * On Atlas, users created with mongosh/db.createUser outside supported flows can be rolled back;
 * use this script, the Atlas UI, Atlas CLI, the dashboard, `POST /api/atlas/database-users`, or another supported integration.
 *
 * Prerequisites: API key pair with permission to manage database users on the project
 * (e.g. Project Owner or Project Database Access Admin).
 *
 * Usage:
 *   node scripts/atlas-create-db-user.js --preset backend --project-id <GROUP_ID> \
 *     --public-key <KEY> --private-key <SECRET> --username mongoadvisor_app
 *
 * Password: set ATLAS_NEW_USER_PASSWORD, or pass --password (discouraged on shared shells),
 * or pipe: echo 'secret' | node scripts/atlas-create-db-user.js ... --password-stdin
 *
 * Optional env: ATLAS_PROJECT_ID, ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY,
 * ATLAS_NEW_USER_PASSWORD, ATLAS_NEW_USER_USERNAME, ATLAS_CLUSTER_NAME
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const readline = require("readline");
const { createAtlasDatabaseUser, atlasErrorMessage, presetDescriptions } = require("../src/atlas-db-users");

const PRESET_HELP = Object.entries(presetDescriptions())
  .map(([k, d]) => `  ${k}  ${d}`)
  .join("\n");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`Missing value after ${a}`);
      return v;
    };
    if (a === "--preset") out.preset = next();
    else if (a === "--project-id") out.projectId = next();
    else if (a === "--public-key") out.publicKey = next();
    else if (a === "--private-key") out.privateKey = next();
    else if (a === "--username") out.username = next();
    else if (a === "--password") out.password = next();
    else if (a === "--password-stdin") out.passwordStdin = true;
    else if (a === "--cluster-name") out.clusterName = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function readPasswordFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = await new Promise((resolve) => {
    const acc = [];
    rl.on("line", (line) => acc.push(line));
    rl.on("close", () => resolve(acc.join("\n")));
  });
  return lines.trim();
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }

  if (args.help) {
    console.log(`Usage: node scripts/atlas-create-db-user.js --preset <backend|metrics> [options]

Options:
  --project-id      Atlas project (group) ID
  --public-key      Atlas API public key
  --private-key     Atlas API private key
  --username        New database username (SCRAM)
  --password        New user password (avoid on shared machines; prefer env/stdin)
  --password-stdin  Read password from stdin (single line)
  --cluster-name    Optional Atlas cluster name to scope the user to one cluster

Env (optional if matching flags omitted):
  ATLAS_PROJECT_ID ATLAS_PUBLIC_KEY ATLAS_PRIVATE_KEY ATLAS_NEW_USER_PASSWORD
  ATLAS_NEW_USER_USERNAME ATLAS_CLUSTER_NAME

Presets:
${PRESET_HELP}
`);
    process.exit(0);
  }

  const preset = args.preset || process.env.ATLAS_PRESET;
  const projectId = args.projectId || process.env.ATLAS_PROJECT_ID;
  const publicKey = args.publicKey || process.env.ATLAS_PUBLIC_KEY;
  const privateKey = args.privateKey || process.env.ATLAS_PRIVATE_KEY;
  const username = args.username || process.env.ATLAS_NEW_USER_USERNAME;

  let password = args.password || process.env.ATLAS_NEW_USER_PASSWORD;
  if (args.passwordStdin) {
    password = await readPasswordFromStdin();
  }

  if (!preset) {
    console.error('Set --preset to "backend" or "metrics".');
    process.exit(1);
  }

  const clusterNameRaw = args.clusterName || process.env.ATLAS_CLUSTER_NAME || "";
  const clusterName = clusterNameRaw.trim() || undefined;

  const result = await createAtlasDatabaseUser({
    projectId,
    publicKey,
    privateKey,
    preset,
    username,
    password,
    clusterName,
  });

  if (!result.ok) {
    console.error(atlasErrorMessage(result));
    if (result.json) console.error(JSON.stringify(result.json, null, 2));
    else if (result.raw) console.error(result.raw.slice(0, 2000));
    process.exit(1);
  }

  console.log(`Created Atlas database user "${username}" (${preset}).`);
  if (result.json) {
    console.log("Response:", JSON.stringify({ username: result.json.username, roles: result.json.roles, scopes: result.json.scopes }, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
