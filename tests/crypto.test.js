const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");

// crypto.js reads ENCRYPTION_KEY at call time, not at require time, so we can
// set it up just for this suite without disturbing the rest of the env.
let previousKey;
before(() => {
  previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
});
after(() => {
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});

const { encrypt, decrypt, isEncrypted } = require("../src/crypto");

test("encrypt + decrypt round-trip recovers the original plaintext", () => {
  const original = "mongodb+srv://user:pass@cluster.example.net/?retryWrites=true";
  const ct = encrypt(original);
  assert.equal(decrypt(ct), original);
});

test("encrypt produces the expected iv:tag:ciphertext layout", () => {
  const ct = encrypt("hello");
  const parts = ct.split(":");
  assert.equal(parts.length, 3, "encrypted form is exactly three colon-separated hex segments");
  assert.equal(parts[0].length, 24, "iv is 12 bytes → 24 hex chars");
  assert.equal(parts[1].length, 32, "auth tag is 16 bytes → 32 hex chars");
  assert.ok(parts[2].length > 0, "ciphertext is non-empty");
});

test("encrypt is non-deterministic (random IV every call)", () => {
  const a = encrypt("same input");
  const b = encrypt("same input");
  assert.notEqual(a, b, "two encrypts of the same plaintext must differ (random IV)");
  assert.equal(decrypt(a), decrypt(b), "but both decrypt to the same plaintext");
});

test("isEncrypted recognises a freshly-encrypted value", () => {
  const ct = encrypt("payload");
  assert.equal(isEncrypted(ct), true);
});

test("isEncrypted rejects plain strings and non-strings", () => {
  assert.equal(isEncrypted("plain text"), false);
  assert.equal(isEncrypted(""), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
  assert.equal(isEncrypted("aa:bb"), false, "two segments — not the encrypted shape");
  assert.equal(isEncrypted("aa:bb:cc:dd"), false, "four segments — not the encrypted shape");
});

test("isEncrypted is permissive on the ciphertext segment but strict on iv/tag length", () => {
  // Right number of segments, wrong iv length.
  assert.equal(isEncrypted("aa:" + "bb".repeat(16) + ":ccdd"), false,
    "iv shorter than 24 hex chars → not recognized as encrypted");
});

test("decrypt rejects tampered ciphertext (GCM auth tag mismatch)", () => {
  const ct = encrypt("authenticated");
  // Flip a single hex char in the ciphertext segment.
  const [iv, tag, body] = ct.split(":");
  const flipped = body[0] === "0" ? "1" + body.slice(1) : "0" + body.slice(1);
  const tampered = `${iv}:${tag}:${flipped}`;
  assert.throws(() => decrypt(tampered), "GCM should refuse to decrypt a tampered ciphertext");
});

test("decrypt rejects an invalid format", () => {
  assert.throws(() => decrypt("not-a-valid-shape"), /Invalid encrypted value format/);
});
