require("dotenv").config();
const express = require("express");
const path = require("path");
const { connect, close } = require("./db");
const { startPolling, stopPolling } = require("./collector");
const { closeAll: closeAllPools } = require("./pool-cache");

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/health", require("./routes/health"));
app.use("/api/clusters", require("./routes/clusters"));
app.use("/api/atlas", require("./routes/atlas-admin"));
app.use("/api/topologies", require("./routes/topologies"));
app.use("/api/metrics", require("./routes/metrics"));

app.use((err, _req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  if (!res.headersSent) {
    res.status(status).json({ error: err.message || "Server error" });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await connect();
  app.listen(PORT, () => console.log(`MongoAdvisor listening on http://localhost:${PORT}`));
  startPolling();
}

process.on("SIGINT", async () => {
  stopPolling();
  await closeAllPools();
  await close();
  process.exit(0);
});

start().catch((err) => {
  console.error("Failed to start:", err);
  const msg = String(err?.message || err || "");
  if (/Authentication failed|AuthenticationFailed/i.test(msg)) {
    console.error(
      "Hint: If this is Atlas and the DB user was created with auth database `admin`, ensure MONGO_URI includes `authSource=admin` (see README Bootstrap).",
    );
  }
  process.exit(1);
});
