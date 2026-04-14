const { Router } = require("express");
const { createAtlasDatabaseUser, presetDescriptions, atlasErrorMessage } = require("../atlas-db-users");
const { logMonitorEvent } = require("../monitor-log");

const router = Router();

/** Preset ids + descriptions for clients (e.g. scripts, curl) */
router.get("/database-users/presets", (_req, res) => {
  const presets = Object.entries(presetDescriptions()).map(([id, description]) => ({ id, description }));
  res.json({ presets });
});

/**
 * Optional defaults (non-secret) for scripts or curl when creating backend users.
 * Set ATLAS_BACKEND_PROJECT_ID and ATLAS_BACKEND_PUBLIC_KEY in the server environment.
 */
router.get("/database-users/defaults", (_req, res) => {
  res.json({
    projectId: process.env.ATLAS_BACKEND_PROJECT_ID || null,
    publicKey: process.env.ATLAS_BACKEND_PUBLIC_KEY || null,
  });
});

/**
 * Create an Atlas database user using credentials supplied in the request body.
 * Same behavior as `npm run atlas:create-user` / scripts/atlas-create-db-user.js.
 */
router.post("/database-users", async (req, res, next) => {
  try {
    const { preset, projectId, publicKey, privateKey, username, password, clusterName } = req.body || {};
    const result = await createAtlasDatabaseUser({
      preset,
      projectId,
      publicKey,
      privateKey,
      username: username != null ? String(username).trim() : "",
      password: password != null ? String(password) : "",
      clusterName: clusterName != null ? String(clusterName).trim() : undefined,
    });

    if (!result.ok) {
      const httpStatus = result.clientError
        ? 400
        : result.status >= 400 && result.status < 600
          ? result.status
          : 502;
      const msg = atlasErrorMessage(result);
      await logMonitorEvent({
        source: "api",
        action: "atlas.databaseUser.create",
        outcome: "error",
        detail: `standalone preset=${preset || "?"} user=${username || "?"}`,
        error: msg,
        meta: { status: result.status },
      });
      return res.status(httpStatus).json({
        ok: false,
        error: msg,
        atlas: result.json || undefined,
      });
    }

    await logMonitorEvent({
      source: "api",
      action: "atlas.databaseUser.create",
      outcome: "ok",
      detail: `standalone preset=${preset} user=${username}`,
      meta: { roles: result.json?.roles, scopes: result.json?.scopes },
    });

    return res.status(201).json({
      ok: true,
      username: result.json?.username,
      roles: result.json?.roles,
      scopes: result.json?.scopes,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
