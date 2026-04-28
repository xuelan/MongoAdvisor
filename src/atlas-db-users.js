const { atlasDigestFetch } = require("./atlas-digest");

const PRESETS = {
  backend: {
    description:
      "MongoAdvisor application DB user (readWrite on mongoadvisor, readAnyDatabase for same-cluster reads)",
    buildPayload: (projectId, username, password, clusterName) => {
      // Atlas requires SCRAM users to authenticate against `admin`.
      // readWrite @ mongoadvisor: app telemetry; readAnyDatabase @ admin: optional reads (e.g. sample DBs on this cluster).
      const payload = {
        groupId: projectId,
        username,
        password,
        databaseName: "admin",
        roles: [
          { roleName: "readWrite", databaseName: "mongoadvisor" },
          { roleName: "readAnyDatabase", databaseName: "admin" },
        ],
      };
      if (clusterName) {
        payload.scopes = [{ name: clusterName, type: "CLUSTER" }];
      }
      return payload;
    },
  },
  metrics: {
    description: "Monitored-cluster metrics reader (collector code paths)",
    buildPayload: (projectId, username, password, clusterName) => {
      const payload = {
        groupId: projectId,
        username,
        password,
        databaseName: "admin",
        roles: [
          { roleName: "clusterMonitor", databaseName: "admin" },
          { roleName: "readAnyDatabase", databaseName: "admin" },
          { roleName: "read", databaseName: "local" },
        ],
      };
      if (clusterName) {
        payload.scopes = [{ name: clusterName, type: "CLUSTER" }];
      }
      return payload;
    },
  },
};

const PRESET_NAMES = Object.keys(PRESETS);

function presetDescriptions() {
  return Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.description]));
}

/**
 * Create a SCRAM database user on Atlas via Administration API.
 * @param {{ projectId: string, publicKey: string, privateKey: string, preset: string, username: string, password: string, clusterName?: string }} params
 * @returns {Promise<{ ok: boolean, status: number, json?: object, raw?: string, clientError?: string }>}
 */
async function createAtlasDatabaseUser(params) {
  const { projectId, publicKey, privateKey, preset, username, password, clusterName } = params;
  const p = PRESETS[preset];
  if (!p) {
    return { ok: false, status: 400, clientError: `Unknown preset "${preset}". Use: ${PRESET_NAMES.join(", ")}` };
  }
  if (!projectId || !publicKey || !privateKey || !username || !password) {
    return {
      ok: false,
      status: 400,
      clientError: "projectId, publicKey, privateKey, username, and password are required",
    };
  }

  const cn = clusterName && String(clusterName).trim() ? String(clusterName).trim() : undefined;
  const payload = p.buildPayload(projectId, username, password, cn);
  const url = `https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/databaseUsers`;
  const resp = await atlasDigestFetch(url, { method: "POST", body: payload }, publicKey, privateKey);
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return {
    ok: resp.ok,
    status: resp.status,
    json: json || undefined,
    raw: json ? undefined : text,
  };
}

function atlasErrorMessage(result) {
  if (result.clientError) return result.clientError;
  const j = result.json;
  if (j && typeof j === "object") {
    return j.detail || j.reason || j.errorCode || JSON.stringify(j).slice(0, 500);
  }
  return (result.raw && result.raw.slice(0, 500)) || `HTTP ${result.status}`;
}

module.exports = {
  PRESETS,
  PRESET_NAMES,
  presetDescriptions,
  createAtlasDatabaseUser,
  atlasErrorMessage,
};
