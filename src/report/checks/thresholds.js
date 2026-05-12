/**
 * Default thresholds for each health-check item. Picked to match common production
 * guidelines (oplog window ≥ 48 h, max documents ~32 KB, fragmentation < 50 %, etc.).
 *
 * Per-report overrides (and a UI control) are out of scope for v1.
 */
module.exports = {
  BuildInfoItem: {
    eol_version: [4, 4, 0],
  },
  CollInfoItem: {
    obj_size_kb: 32,
    collection_size_gb: 2048,
    fragmentation_ratio: 0.5,
    index_size_ratio: 0.2,
    ops_latency_ms: 100,
  },
  IndexInfoItem: {
    unused_index_days: 7,
    num_indexes: 10,
  },
  ClusterItem: {
    replication_lag_seconds: 0,
    oplog_window_hours: 48,
  },
  ServerStatusItem: {
    used_connection_ratio: 0.8,
    query_targeting: 1000,
    query_targeting_obj: 1000,
    cache_read_into_mb: 100,
  },
  ShardKeyItem: {
    sharding_imbalance_percentage: 0.1,
  },
};
