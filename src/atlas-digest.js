const crypto = require("crypto");

/** Atlas Admin API v2 media type (match collector slow-query calls). */
const ATLAS_ACCEPT = "application/vnd.atlas.2023-01-01+json";

/**
 * HTTP Digest–authenticated fetch for Atlas Admin API (GET/POST JSON).
 * @param {string} url
 * @param {{ method?: string, body?: object|string, headers?: Record<string,string> }} opts
 * @param {string} publicKey Atlas API public key
 * @param {string} privateKey Atlas API private key
 */
async function atlasDigestFetch(url, opts = {}, publicKey, privateKey) {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body;
  const extra = opts.headers || {};

  const urlObj = new URL(url);
  const requestUri = urlObj.pathname + urlObj.search;

  const headers = {
    Accept: ATLAS_ACCEPT,
    ...extra,
  };
  if (body != null && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = ATLAS_ACCEPT;
  }

  const init1 = { method, headers };
  if (body != null) {
    init1.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const resp1 = await fetch(url, init1);
  if (resp1.status !== 401) return resp1;

  const wwwAuth = resp1.headers.get("www-authenticate") || "";
  await resp1.text().catch(() => {});

  const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] || "";
  const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] || "";
  const qop = wwwAuth.match(/qop="([^"]+)"/)?.[1] || "auth";

  const nc = "00000001";
  const cnonce = crypto.randomBytes(16).toString("hex");

  const ha1 = crypto.createHash("md5").update(`${publicKey}:${realm}:${privateKey}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${requestUri}`).digest("hex");
  const response = crypto
    .createHash("md5")
    .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    .digest("hex");

  const authHeader =
    `Digest username="${publicKey}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${requestUri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;

  const init2 = {
    method,
    headers: { ...headers, Authorization: authHeader },
  };
  if (body != null) {
    init2.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return fetch(url, init2);
}

module.exports = { atlasDigestFetch, ATLAS_ACCEPT };
