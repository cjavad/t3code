/** Chunks are immutable. Only an offline copy replaces the baseline and its event boundary. */
export const STORAGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orchestration_storage_baseline (
    id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL,
    application_sequence INTEGER NOT NULL, agent_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL, policy_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orchestration_storage_streams (
    aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
    agent_sequence INTEGER NOT NULL, PRIMARY KEY (aggregate_kind, stream_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS orchestration_storage_tables (
    table_name TEXT PRIMARY KEY, columns_json TEXT NOT NULL, schema_sql TEXT NOT NULL,
    row_count INTEGER NOT NULL, sha256 TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orchestration_storage_chunks (
    chunk_id INTEGER PRIMARY KEY, table_name TEXT NOT NULL, row_count INTEGER NOT NULL,
    raw_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, payload BLOB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS orchestration_storage_chunks_table_idx
    ON orchestration_storage_chunks (table_name, chunk_id)`,
] as const;

export const isBaselineTable = (name: string) =>
  name.startsWith("orchestration_v2_projection_") ||
  name === "orchestration_v2_turn_item_positions";
