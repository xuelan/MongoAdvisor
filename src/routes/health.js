const { Router } = require("express");
const { getDb } = require("../db");

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const result = await getDb().command({ ping: 1 });
    res.json({ status: "ok", mongo: result.ok === 1 ? "connected" : "error" });
  } catch {
    res.status(503).json({ status: "error", mongo: "disconnected" });
  }
});

module.exports = router;
