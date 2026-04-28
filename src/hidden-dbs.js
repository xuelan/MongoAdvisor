/**
 * Top-level database names to hide from namespace pickers and from collector DB walks.
 * Includes the MongoAdvisor app DB (`mongoadvisor`) and other non-workload namespaces.
 */
const HIDDEN_TOP_LEVEL_DBS = ["admin", "config", "local", "mongoadvisor", "#mongodb-mcp"];

const HIDDEN_SET = new Set(HIDDEN_TOP_LEVEL_DBS);

function isHiddenTopLevelDb(dbName) {
  return HIDDEN_SET.has(dbName);
}

module.exports = { HIDDEN_TOP_LEVEL_DBS, HIDDEN_SET, isHiddenTopLevelDb };
