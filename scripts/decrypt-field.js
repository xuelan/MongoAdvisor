#!/usr/bin/env node
/**
 * Decrypt a MongoAdvisor-stored ciphertext (AES-256-GCM) using ENCRYPTION_KEY from `.env`
 * in the project root — same as `decryptField()` in `src/routes/clusters.js` / `src/crypto.js`.
 *
 * **Security:** stdout will contain secrets (connection URIs, API keys). Use only on your
 * machine; avoid piping into logs, tickets, or screen capture.
 *
 * Usage:
 *   node scripts/decrypt-field.js '<ivHex:tagHex:cipherHex>'
 *   npm run decrypt:field -- '<ivHex:tagHex:cipherHex>'
 *   echo '<packed>' | node scripts/decrypt-field.js --stdin
 *
 * Prerequisites: `.env` with `ENCRYPTION_KEY` (64 hex chars), same key used when the value was encrypted.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { decrypt, isEncrypted } = require("../src/crypto");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("").trim()));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let packed = "";

  if (argv[0] === "--help" || argv[0] === "-h") {
    console.error(`Usage:
  node scripts/decrypt-field.js '<ivHex:tagHex:cipherHex>'
  echo '<packed>' | node scripts/decrypt-field.js --stdin`);
    process.exit(0);
  }

  if (argv[0] === "--stdin") {
    packed = await readStdin();
  } else if (argv.length >= 1) {
    packed = argv.join(" ").trim();
  }

  if (!packed) {
    console.error(
      "Missing ciphertext. Pass one argument (quoted packed string) or use --stdin.\n" +
        "Example: node scripts/decrypt-field.js 'a1b2...:c3d4...:e5f6...'",
    );
    process.exit(1);
  }

  if (!isEncrypted(packed)) {
    console.error(
      "Input does not match MongoAdvisor encrypted format (expected three colon-separated hex segments).",
    );
    process.exit(1);
  }

  let plain;
  try {
    plain = decrypt(packed);
  } catch (e) {
    console.error("Decrypt failed:", e.message || e);
    console.error("Check ENCRYPTION_KEY matches the key used when this value was stored.");
    process.exit(1);
  }

  process.stderr.write("[decrypt-field] WARNING: plaintext credential on stdout — handle output safely.\n");
  process.stdout.write(plain + (plain.endsWith("\n") ? "" : "\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
