/**
 * When `isPolling` is false on a cluster document, scheduled collectors skip that cluster.
 * Missing or any other value means polling is enabled (backward compatible).
 */
function isClusterPollingEnabled(cluster) {
  return Boolean(cluster && cluster.isPolling !== false);
}

module.exports = { isClusterPollingEnabled };
