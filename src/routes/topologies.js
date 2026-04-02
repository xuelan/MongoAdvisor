const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { discoverOne } = require("../discovery");

const router = Router();
const TOPOLOGIES = "topologies";
const CLUSTERS = "clusters";

router.get("/", async (_req, res, next) => {
  try {
    const topologies = await getDb().collection(TOPOLOGIES).find().toArray();
    res.json(topologies);
  } catch (err) {
    next(err);
  }
});

router.get("/:clusterId", async (req, res, next) => {
  try {
    const topology = await getDb()
      .collection(TOPOLOGIES)
      .findOne({ clusterId: new ObjectId(req.params.clusterId) });
    if (!topology) return res.status(404).json({ error: "Topology not found for this cluster" });
    res.json(topology);
  } catch (err) {
    next(err);
  }
});

router.post("/:clusterId/discover", async (req, res, next) => {
  try {
    const cluster = await getDb()
      .collection(CLUSTERS)
      .findOne({ _id: new ObjectId(req.params.clusterId) });
    if (!cluster) return res.status(404).json({ error: "Cluster not found" });

    const topology = await discoverOne(cluster);
    res.json(topology);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
