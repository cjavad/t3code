// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Exercises the persisted chunk encoding and digest.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { assert, it } from "@effect/vitest";
import { decodeStorageChunk } from "@t3tools/shared/compressedSqlite";
import { STORAGE_SCHEMA } from "@t3tools/shared/sqliteStorageSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import RemoveHumanNotes from "./1004_RemoveHumanNotes.ts";

it.effect(
  "removes notes from live projections, replay events and baseline chunks without changing human messages",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of STORAGE_SCHEMA) yield* sql.unsafe(statement);
      yield* sql`CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, role TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES ('u','user','{"text":"keep"}'),('n','note','{"text":"remove"}')`;
      yield* sql`INSERT INTO orchestration_events VALUES (1,'message.updated','{"role":"user"}'),(2,'message.updated','{"role":"note"}'),(3,'thread.metadata-updated','{}')`;
      const rows = [
        ["u", "user", '{"text":"keep"}'],
        ["n", "note", '{"text":"remove"}'],
      ];
      const raw = Buffer.from(JSON.stringify(rows));
      const digest = NodeCrypto.createHash("sha256").update(raw).digest("hex");
      const tableDigest = NodeCrypto.createHash("sha256")
        .update(rows.map((row) => JSON.stringify(row) + "\n").join(""))
        .digest("hex");
      yield* sql`INSERT INTO orchestration_storage_tables VALUES ('orchestration_v2_projection_messages','["message_id","role","payload_json"]','schema',2,${tableDigest})`;
      yield* sql`INSERT INTO orchestration_storage_chunks VALUES (1,'orchestration_v2_projection_messages',2,${raw.length},${digest},${NodeZlib.zstdCompressSync(raw)})`;
      yield* RemoveHumanNotes;
      assert.deepStrictEqual(
        yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`,
        [{ message_id: "u" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT sequence FROM orchestration_events ORDER BY sequence`,
        [{ sequence: 1 }, { sequence: 3 }],
      );
      const chunks = yield* sql<{
        payload: Uint8Array;
        sha256: string;
        raw_bytes: number;
        row_count: number;
      }>`SELECT * FROM orchestration_storage_chunks`;
      assert.deepStrictEqual(
        decodeStorageChunk(chunks[0]!.payload, chunks[0]!.sha256, chunks[0]!.raw_bytes),
        [rows[0]!],
      );
      assert.equal(chunks[0]!.row_count, 1);
      const tables = yield* sql<{
        row_count: number;
        sha256: string;
      }>`SELECT * FROM orchestration_storage_tables`;
      assert.equal(tables[0]!.row_count, 1);
      assert.equal(
        tables[0]!.sha256,
        NodeCrypto.createHash("sha256")
          .update(JSON.stringify(rows[0]) + "\n")
          .digest("hex"),
      );
      yield* RemoveHumanNotes;
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_storage_tables`, tables);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
