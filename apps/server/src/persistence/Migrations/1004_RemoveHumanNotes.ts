// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Rewrites persisted baseline chunks with their canonical codec and digest.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { decodeStorageChunk } from "@t3tools/shared/compressedSqlite";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tableName = "orchestration_v2_projection_messages";
  const tables = yield* sql<{ columns_json: string }>`
    SELECT columns_json FROM orchestration_storage_tables WHERE table_name = ${tableName}
  `;
  if (tables[0]) {
    const columns: string[] = JSON.parse(tables[0].columns_json);
    const role = columns.indexOf("role");
    if (role < 0) throw new Error("Message baseline is missing its role column");
    const hash = NodeCrypto.createHash("sha256");
    let count = 0;
    let cursor = 0;
    while (true) {
      const chunks = yield* sql<{
        chunk_id: number;
        payload: Uint8Array;
        sha256: string;
        raw_bytes: number;
      }>`SELECT chunk_id, payload, sha256, raw_bytes FROM orchestration_storage_chunks
        WHERE table_name = ${tableName} AND chunk_id > ${cursor} ORDER BY chunk_id LIMIT 1`;
      const chunk = chunks[0];
      if (!chunk) break;
      const rows = decodeStorageChunk(chunk.payload, chunk.sha256, chunk.raw_bytes);
      const retained = rows.filter((row) => row[role] !== "note");
      for (const row of retained) {
        hash.update(JSON.stringify(row));
        hash.update("\n");
        count++;
      }
      if (retained.length !== rows.length) {
        const raw = Buffer.from(JSON.stringify(retained));
        const packed = NodeZlib.zstdCompressSync(raw);
        const digest = NodeCrypto.createHash("sha256").update(raw).digest("hex");
        yield* sql`UPDATE orchestration_storage_chunks
          SET payload = ${packed}, sha256 = ${digest}, raw_bytes = ${raw.length}, row_count = ${retained.length}
          WHERE chunk_id = ${chunk.chunk_id}`;
      }
      cursor = chunk.chunk_id;
      yield* Effect.yieldNow;
    }
    yield* sql`UPDATE orchestration_storage_tables SET row_count = ${count}, sha256 = ${hash.digest("hex")}
      WHERE table_name = ${tableName}`;
  }
  yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE role = 'note'`;
  yield* sql`DELETE FROM orchestration_events
    WHERE event_type = 'message.updated' AND json_extract(payload_json, '$.role') = 'note'`;
});
