/**
 * Top-level database names to hide from namespace pickers and from collector DB walks.
 * Includes the MongoAdvisor app DB (`mongoadvisor`) and legacy internal DB (`mongomonitor`)
 * so old $queryStats rows do not clutter the UI after that database is dropped on cluster.
 */
const HIDDEN_TOP_LEVEL_DBS = ["admin", "config", "local", "mongoadvisor", "mongomonitor", "#mongodb-mcp"];

const HIDDEN_SET = new Set(HIDDEN_TOP_LEVEL_DBS);

function isHiddenTopLevelDb(dbName) {
  return HIDDEN_SET.has(dbName);
}

module.exports = { HIDDEN_TOP_LEVEL_DBS, HIDDEN_SET, isHiddenTopLevelDb };
