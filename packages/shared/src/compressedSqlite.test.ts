// @effect-diagnostics nodeBuiltinImport:off -- Verifies persisted Node crypto digest compatibility.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import { expect, it } from "@effect/vitest";
import { decodeStorageChunk, registerCompressedSqlite } from "./compressedSqlite.ts";
import { STORAGE_SCHEMA } from "./sqliteStorageSchema.ts";

function fixture() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  for (const statement of STORAGE_SCHEMA) db.exec(statement);
  registerCompressedSqlite(db);
  db.exec(`CREATE TABLE orchestration_v2_projection_turn_items (
    id TEXT PRIMARY KEY,
    payload_json TEXT GENERATED ALWAYS AS (COALESCE(t3_payload_inline,t3_read_payload(t3_payload_chunk,t3_payload_row,t3_payload_column))) VIRTUAL NOT NULL,
    t3_payload_inline TEXT, t3_payload_chunk INTEGER, t3_payload_row INTEGER, t3_payload_column INTEGER
  ); CREATE INDEX payload_lookup ON orchestration_v2_projection_turn_items(id)`);
  const raw = Buffer.from(JSON.stringify([["item", '{"text":"original"}']]));
  db.prepare(
    "INSERT INTO orchestration_storage_chunks VALUES (1,'orchestration_v2_projection_turn_items',1,?,?,?)",
  ).run(
    raw.length,
    NodeCrypto.createHash("sha256").update(raw).digest("hex"),
    NodeZlib.gzipSync(raw),
  );
  db.exec(
    "INSERT INTO orchestration_v2_projection_turn_items(id,t3_payload_chunk,t3_payload_row,t3_payload_column) VALUES ('item',1,0,1)",
  );
  return { db, rewrite: registerCompressedSqlite(db) };
}

it("reads indexed generated payloads and writes inline without changing the recovery chunk", () => {
  const { db, rewrite } = fixture();
  try {
    expect(
      db
        .prepare(
          "SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_turn_items INDEXED BY payload_lookup WHERE id='item'",
        )
        .get()?.text,
    ).toBe("original");
    db.prepare(
      rewrite(
        "INSERT INTO orchestration_v2_projection_turn_items(id,payload_json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",
      ),
    ).run("item", '{"text":"new"}');
    expect(
      db.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items").get()
        ?.payload_json,
    ).toBe('{"text":"new"}');
    expect(db.prepare("SELECT t3_read_payload(1,0,1) AS payload").get()?.payload).toBe(
      '{"text":"original"}',
    );
  } finally {
    db.close();
  }
});

it("rewrites assignment targets while preserving CASE comparisons and SQL literals", () => {
  const { db, rewrite } = fixture();
  try {
    db.exec(
      rewrite(
        `UPDATE orchestration_v2_projection_turn_items SET payload_json=CASE WHEN payload_json='{"text":"original"}' THEN '{"text":"SET payload_json = hello"}' ELSE payload_json END WHERE id='item'`,
      ),
    );
    expect(
      db
        .prepare(
          "SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_turn_items",
        )
        .get()?.text,
    ).toBe("SET payload_json = hello");
  } finally {
    db.close();
  }
});

it("rejects corrupt chunks, wrong lengths and invalid coordinates", () => {
  const { db } = fixture();
  try {
    expect(() => db.prepare("SELECT t3_read_payload(1,-1,1)").get()).toThrow(/coordinates/);
    const raw = Buffer.from("[[]]");
    expect(() => decodeStorageChunk(NodeZlib.gzipSync(raw), "wrong")).toThrow(/verification/);
    expect(() =>
      decodeStorageChunk(
        NodeZlib.gzipSync(raw),
        NodeCrypto.createHash("sha256").update(raw).digest("hex"),
        raw.length + 1,
      ),
    ).toThrow(/verification/);
    const row = db.prepare("SELECT payload FROM orchestration_storage_chunks").get()!;
    db.prepare("UPDATE orchestration_storage_chunks SET sha256=?").run("wrong");
    registerCompressedSqlite(db);
    expect(() => db.prepare("SELECT t3_read_payload(1,0,1)").get()).toThrow(/verification/);
    expect(row.payload).toBeInstanceOf(Uint8Array);
  } finally {
    db.close();
  }
});
