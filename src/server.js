require("dotenv").config();
const express = require("express");
const path = require("path");
const { connect, close } = require("./db");
const { discoverAll } = require("./discovery");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/health", require("./routes/health"));
app.use("/api/clusters", require("./routes/clusters"));
app.use("/api/topologies", require("./routes/topologies"));

const PORT = process.env.PORT || 3000;

async function start() {
  await connect();
  app.listen(PORT, () => console.log(`MongoMonitor listening on http://localhost:${PORT}`));
  discoverAll().catch((err) => console.error("Discovery error:", err.message));
}

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
