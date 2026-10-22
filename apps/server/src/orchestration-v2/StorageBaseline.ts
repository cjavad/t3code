import { canonicalizeThreadPullRequestProjections } from "../persistence/Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
// @effect-diagnostics nodeBuiltinImport:off - baseline digest uses the same format as the offline exporter.
import * as NodeCrypto from "node:crypto";
import {
  COMPRESSED_PROJECTION_TABLES,
  decodeSqliteRow,
  decodeStorageChunk,
  encodeSqliteRowJson,
} from "@t3tools/shared/compressedSqlite";
import { isBaselineTable } from "@t3tools/shared/sqliteStorageSchema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

const decodeColumns = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Called inside the rebuild transaction. Auth, receipts and effects are never restored. */
export const restoreStorageBaseline = Effect.fn("StorageBaseline.restore")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const installed =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_storage_baseline'`;
  if (installed.length === 0) return { applicationSequence: 0, agentSequence: 0 };
  const baseline = yield* sql<{
    format_version: number;
    application_sequence: number;
    agent_sequence: number;
  }>`
    SELECT format_version, application_sequence, agent_sequence FROM orchestration_storage_baseline WHERE id = 1
  `;
  const boundary = baseline[0];
  if (boundary === undefined) return { applicationSequence: 0, agentSequence: 0 };
  if (boundary.format_version !== 1) throw new Error("Unsupported storage baseline version");
  const tables = yield* sql<{
    table_name: string;
    columns_json: string;
    row_count: number;
    sha256: string;
  }>`
    SELECT table_name, columns_json, row_count, sha256 FROM orchestration_storage_tables ORDER BY table_name
  `;
  const indexed = new Set<string>(COMPRESSED_PROJECTION_TABLES);
  for (const table of tables) {
    if (!isBaselineTable(table.table_name)) throw new Error("Invalid storage baseline table");
    const columns = yield* decodeColumns(table.columns_json);
    // Also clear tables absent from older rebuild code, including metadata and future projections.
    yield* sql`DELETE FROM ${sql(table.table_name)}`;
    const payloadColumn = columns.indexOf("payload_json");
    const hash = NodeCrypto.createHash("sha256");
    let count = 0,
      cursor = 0;
    while (true) {
      const chunks = yield* sql<{
        chunk_id: number;
        payload: Uint8Array;
        sha256: string;
        raw_bytes: number;
        row_count: number;
      }>`
        SELECT chunk_id, payload, sha256, raw_bytes, row_count FROM orchestration_storage_chunks
        WHERE table_name = ${table.table_name} AND chunk_id > ${cursor} ORDER BY chunk_id LIMIT 16
      `;
      for (const chunk of chunks) {
        const rows = decodeStorageChunk(chunk.payload, chunk.sha256, chunk.raw_bytes);
        if (rows.length !== chunk.row_count) throw new Error("Invalid baseline row count");
        const records = rows.map((stored, rowIndex) => {
          const values = decodeSqliteRow(stored);
          if (values.length !== columns.length) throw new Error("Invalid baseline row width");
          hash.update(encodeSqliteRowJson(values));
          hash.update("\n");
          count++;
          const record: Record<string, unknown> = {};
          for (const [columnIndex, column] of columns.entries()) {
            if (indexed.has(table.table_name) && columnIndex === payloadColumn) continue;
            record[column] = values[columnIndex];
          }
          if (indexed.has(table.table_name))
            Object.assign(record, {
              t3_payload_chunk: chunk.chunk_id,
              t3_payload_row: rowIndex,
              t3_payload_column: payloadColumn,
            });
          return record;
        });
        if (records.length > 0)
          yield* sql`INSERT INTO ${sql(table.table_name)} ${sql.insert(records)}`;
        cursor = chunk.chunk_id;
      }
      if (chunks.length < 16) break;
      yield* Effect.yieldNow;
    }
    if (count !== table.row_count || hash.digest("hex") !== table.sha256)
      throw new Error("Storage baseline failed verification");
  }
  // Older immutable baselines predate the upstream PR link migration.
  yield* canonicalizeThreadPullRequestProjections();
  return {
    applicationSequence: boundary.application_sequence,
    agentSequence: boundary.agent_sequence,
  };
});
