const { randomBytes, createCipheriv, createDecipheriv } = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64)
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(packed) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = packed.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted value format");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
}

function isEncrypted(value) {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === IV_LEN * 2 && parts[1].length === TAG_LEN * 2;
}

module.exports = { encrypt, decrypt, isEncrypted };
