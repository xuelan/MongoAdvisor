/**
 * /api/reports — getMongoData offline report uploads.
 *
 * Endpoints:
 *   POST   /                          multipart upload (N files, ≤14 MB each), creates a report
 *   GET    /                          list reports, newest first
 *   GET    /:id                       fetch a single report (normalized + findings + nodes)
 *   GET    /:id/download.html         self-contained HTML download (see html-builder.js)
 *   DELETE /:id                       delete a report and its raw uploads
 */

const { Router } = require("express");
const multer = require("multer");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { parse, normalize } = require("../report/parser");
const { group } = require("../report/grouper");
const { runAll, summarize } = require("../report/checks");
const { buildSelfContained } = require("../report/html-builder");
const { logMonitorEvent } = require("../monitor-log");

const router = Router();
const COLLECTION = "reports";
const RAW_COLLECTION = "reports_raw";

const MAX_FILE_MB = parseInt(process.env.REPORT_MAX_FILE_MB || "14", 10);
const MAX_FILES = parseInt(process.env.REPORT_MAX_FILES || "20", 10);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: MAX_FILES,
  },
});

function summaryNodes(grouped) {
  return grouped.nodes.map((n) => ({
    host: n.host,
    isMongos: n.isMongos,
    role: n.role,
    version: n.version,
    processName: n.processName,
    setName: n.setName,
    filename: n.file?.name || null,
  }));
}

function listProjection() {
  return {
    name: 1,
    createdAt: 1,
    topology: 1,
    setName: 1,
    summary: 1,
    meta: 1,
    "nodes.host": 1,
    "nodes.role": 1,
  };
}

router.get("/", async (_req, res, next) => {
  try {
    const docs = await getDb()
      .collection(COLLECTION)
      .find({}, { projection: listProjection() })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

router.post("/", upload.array("files", MAX_FILES), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Upload at least one JSON file (field name 'files')" });
    }

    const parsedFiles = [];
    for (const f of files) {
      let sections;
      try {
        sections = parse(f.buffer.toString("utf8"));
      } catch (err) {
        return res.status(400).json({
          error: `Could not parse ${f.originalname}: ${err.message}`,
        });
      }
      const normalized = normalize(sections);
      parsedFiles.push({
        parsed: normalized,
        sections,
        file: { name: f.originalname, size: f.size },
      });
    }

    const grouped = group(parsedFiles.map(({ parsed, file }) => ({ parsed, file })));
    const findings = runAll(grouped);
    const summary = summarize(findings);

    // Collection / index counts for the summary card.
    let totalCollections = 0;
    let totalIndexes = 0;
    const versions = new Set();
    for (const node of grouped.nodes) {
      if (node.version) versions.add(node.version);
      const dbs = node.normalized?.databases || [];
      for (const db of dbs) {
        for (const coll of db.collections) {
          totalCollections++;
          totalIndexes += (coll.indexes || []).length;
        }
      }
    }

    const now = new Date();
    const name =
      (req.body?.name && String(req.body.name).trim()) ||
      `${grouped.setName || "report"} — ${now.toISOString().replace(/\.\d+Z$/, "Z")}`;

    const reportDoc = {
      name,
      createdAt: now,
      topology: grouped.topology,
      setName: grouped.setName,
      nodes: summaryNodes(grouped),
      // Normalized payload — heavy but fits the BSON limit since heavy WT stats live one
      // level deeper and we don't copy them into per-finding evidence.
      normalized: grouped.nodes.map((n) => ({
        host: n.host,
        role: n.role,
        setName: n.setName,
        normalized: n.normalized,
      })),
      groups: grouped.groups.map((g) => ({
        setName: g.setName,
        topologyHint: g.topologyHint,
        nodes: g.nodes.map((n) => n.host),
      })),
      findings,
      summary: {
        ...summary,
        mongoVersions: Array.from(versions).sort(),
        totalCollections,
        totalIndexes,
        nodeCount: grouped.nodes.length,
      },
      meta: {
        getMongoDataVersion: grouped.nodes[0]?.normalized?.getMongoDataVersion || null,
        capturedAt: grouped.nodes[0]?.normalized?.capturedAt || null,
        files: files.map((f) => ({ name: f.originalname, size: f.size })),
      },
    };

    const ins = await getDb().collection(COLLECTION).insertOne(reportDoc);
    const reportId = ins.insertedId;

    // Store the raw EJSON separately — one doc per uploaded file. Avoids the 16 MB
    // BSON-doc cap blowing up when multiple files are bundled into one report.
    const rawDocs = files.map((f) => ({
      reportId,
      filename: f.originalname,
      size: f.size,
      uploadedAt: now,
      rawEjson: f.buffer.toString("utf8"),
    }));
    if (rawDocs.length > 0) {
      await getDb().collection(RAW_COLLECTION).insertMany(rawDocs);
    }

    await logMonitorEvent({
      source: "api",
      action: "report.create",
      outcome: "ok",
      targetCollection: COLLECTION,
      detail: `report created (${files.length} file(s), ${findings.length} findings)`,
      meta: { reportId, topology: grouped.topology, setName: grouped.setName },
    });

    res.status(201).json({ id: reportId, name, summary: reportDoc.summary });
  } catch (err) {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({ error: `File too large — limit is ${MAX_FILE_MB} MB per file.` });
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const doc = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!doc) return res.status(404).json({ error: "Report not found" });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/download.html", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const doc = await getDb().collection(COLLECTION).findOne({ _id: oid });
    if (!doc) return res.status(404).send("Report not found");
    const html = buildSelfContained(doc);
    const safeName = (doc.name || "report")
      .replace(/[^a-z0-9_\-]+/gi, "_")
      .slice(0, 60);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.mongoadvisor.html"`,
    );
    res.send(html);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const oid = new ObjectId(req.params.id);
    const r = await getDb().collection(COLLECTION).deleteOne({ _id: oid });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Report not found" });
    await getDb().collection(RAW_COLLECTION).deleteMany({ reportId: oid });
    await logMonitorEvent({
      source: "api",
      action: "report.delete",
      outcome: "ok",
      targetCollection: COLLECTION,
      detail: `report ${oid} deleted`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
