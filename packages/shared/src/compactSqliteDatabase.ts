import { indexedMessageConditionSql, indexedMessageTextSql } from "./messageSearchSql.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synchronous offline SQLite exporter; hashes and timestamps form the persisted format.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import {
  COMPRESSED_PROJECTION_TABLES,
  encodeSqliteRow,
  registerCompressedSqlite,
} from "./compressedSqlite.ts";
import { isBaselineTable, STORAGE_SCHEMA } from "./sqliteStorageSchema.ts";
import { retainToolOutput, TOOL_OUTPUT_RETENTION } from "./toolOutputRetention.ts";

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const scalar = (db: NodeSqlite.DatabaseSync, query: string) =>
  Number(Object.values(db.prepare(query).get() ?? {})[0] ?? 0);
const compressed = new Set<string>(COMPRESSED_PROJECTION_TABLES);
const originalColumns = (db: NodeSqlite.DatabaseSync, table: string): string[] => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table);
  if (typeof row?.sql === "string" && row.sql.includes("t3_payload_inline")) {
    const manifest = db
      .prepare("SELECT columns_json FROM orchestration_storage_tables WHERE table_name=?")
      .get(table);
    if (typeof manifest?.columns_json !== "string")
      throw new Error("Missing compressed table schema");
    return JSON.parse(manifest.columns_json);
  }
  return db
    .prepare(`PRAGMA table_info(${quoted(table)})`)
    .all()
    .map((row) => String(row.name));
};

export interface StorageCompactionReport {
  readonly sourceBytes: number;
  readonly destinationBytes: number;
  readonly elapsedSeconds: number;
  readonly applicationSequence: number;
  readonly agentSequence: number;
  readonly removedEventCount: number;
  readonly trimmedOutputCount: number;
  readonly tables: ReadonlyArray<{ name: string; rows: number; chunks: number; sha256: string }>;
}

/** Offline copy only. A live writer's WAL is included in the read transaction's consistent snapshot. */
export function compactSqliteDatabase(input: {
  source: string;
  destination: string;
  now?: string;
  timeoutMs?: number;
  onProgress?: (progress: {
    table: string;
    rows: number;
    elapsedSeconds: number;
    fileBytes: number;
  }) => void;
}): StorageCompactionReport {
  if (
    NodePath.resolve(input.source) === NodePath.resolve(input.destination) ||
    NodeFS.existsSync(input.destination)
  ) {
    throw new Error("Compaction requires a new destination separate from the source");
  }
  const started = Date.now();
  const now = input.now ?? new Date().toISOString();
  const cutoff = new Date(
    Date.parse(now) - TOOL_OUTPUT_RETENTION.minimumAgeDays * 86400_000,
  ).toISOString();
  const source = new NodeSqlite.DatabaseSync(input.source, { readOnly: true });
  let destination: NodeSqlite.DatabaseSync | undefined;
  let succeeded = false;
  const checkDeadline = () => {
    if (Date.now() - started > (input.timeoutMs ?? 300_000))
      throw new Error("Compaction timed out; source is unchanged");
  };
  try {
    registerCompressedSqlite(source);
    source.exec("PRAGMA cache_size=-32768; BEGIN");
    const applicationSequence = scalar(
      source,
      `SELECT MAX(sequence) FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')`,
    );
    const agentSequence = scalar(
      source,
      `SELECT MAX(sequence) FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water WHERE (aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')) AND application_event_version=2 AND aggregate_kind='thread'`,
    );
    const hasBaseline =
      scalar(
        source,
        "SELECT COUNT(*) FROM sqlite_master WHERE name='orchestration_storage_baseline'",
      ) !== 0;
    const previous = hasBaseline
      ? source
          .prepare(
            "SELECT application_sequence, agent_sequence FROM orchestration_storage_baseline WHERE id=1",
          )
          .get()
      : undefined;
    const appHead = Math.max(applicationSequence, Number(previous?.application_sequence ?? 0));
    const agentHead = Math.max(agentSequence, Number(previous?.agent_sequence ?? 0));
    const metadata = scalar(
      source,
      "SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'",
    );
    if (metadata !== agentHead)
      throw new Error("Projection state is not at the event boundary; rebuild before compaction");
    checkDeadline();
    destination = new NodeSqlite.DatabaseSync(input.destination);
    const target = destination;
    target.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-32768; BEGIN");
    for (const statement of STORAGE_SCHEMA) target.exec(statement);
    registerCompressedSqlite(target);
    const schemas = source
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'orchestration_storage_%' ORDER BY type='table' DESC, name",
      )
      .all();
    const tableTypes = new Map(
      source
        .prepare("PRAGMA table_list")
        .all()
        .map((row) => [String(row.name), String(row.type)]),
    );
    const searchTable = schemas.find((row) => row.name === "orchestration_v2_message_search");
    const definitions = schemas.filter((row) => {
      if (row.type !== "table") return false;
      const kind = tableTypes.get(String(row.name));
      if (kind === "shadow") return false;
      if (kind === "virtual") {
        if (row.name !== "orchestration_v2_message_search")
          throw new Error(`Unsupported virtual table: ${row.name}`);
        return false;
      }
      return true;
    });
    const columnsByTable = new Map<string, string[]>();
    for (const row of definitions) {
      const name = String(row.name);
      const columns = originalColumns(source, name);
      columnsByTable.set(name, columns);
      let schema = String(row.sql);
      if (compressed.has(name)) {
        if (schema.includes("t3_payload_inline")) {
          schema = String(
            source
              .prepare("SELECT schema_sql FROM orchestration_storage_tables WHERE table_name=?")
              .get(name)?.schema_sql,
          );
        }
        schema = schema.replace(
          /payload_json\s+TEXT\s+NOT\s+NULL/i,
          `payload_json TEXT GENERATED ALWAYS AS (COALESCE(t3_payload_inline, t3_read_payload(t3_payload_chunk,t3_payload_row,t3_payload_column))) VIRTUAL NOT NULL,
          t3_payload_inline TEXT, t3_payload_chunk INTEGER, t3_payload_row INTEGER, t3_payload_column INTEGER`,
        );
        if (!schema.includes("t3_payload_inline")) throw new Error("Unsupported payload schema");
      }
      target.exec(schema);
    }
    const latestRuns = new Map<string, string>();
    for (const row of source
      .prepare("SELECT thread_id,run_id FROM orchestration_v2_projection_runs ORDER BY ordinal")
      .iterate())
      latestRuns.set(String(row.thread_id), String(row.run_id));
    const saveChunk = target.prepare(
      "INSERT INTO orchestration_storage_chunks(table_name,row_count,raw_bytes,sha256,payload) VALUES (?,?,?,?,?)",
    );
    const saveTable = target.prepare("INSERT INTO orchestration_storage_tables VALUES (?,?,?,?,?)");
    const reports: Array<{ name: string; rows: number; chunks: number; sha256: string }> = [];
    let trimmedOutputCount = 0;
    let lastProgress = started;
    let copiedEvents = 0;
    for (const definition of definitions) {
      const name = String(definition.name);
      const columns = columnsByTable.get(name)!;
      const payloadColumn = columns.indexOf("payload_json");
      const baseline = isBaselineTable(name);
      const indexed = compressed.has(name);
      const liveColumns = indexed
        ? [
            ...columns.filter((column) => column !== "payload_json"),
            "t3_payload_chunk",
            "t3_payload_row",
            "t3_payload_column",
          ]
        : columns;
      const insert = target.prepare(
        `INSERT INTO ${quoted(name)} (${liveColumns.map(quoted).join(",")}) VALUES (${liveColumns.map(() => "?").join(",")})`,
      );
      const hash = NodeCrypto.createHash("sha256");
      let rowCount = 0,
        chunks = 0,
        rawBytes = 0;
      let buffer: NodeSqlite.SQLInputValue[][] = [];
      let encodedRows: string[] = [];
      const flush = () => {
        if (buffer.length === 0) return;
        const raw = Buffer.from(`[${encodedRows.join(",")}]`);
        const packed = NodeZlib.zstdCompressSync(raw, {
          params: { [NodeZlib.constants.ZSTD_c_compressionLevel]: 3 },
        });
        const chunkId = Number(
          saveChunk.run(
            name,
            buffer.length,
            raw.length,
            NodeCrypto.createHash("sha256").update(raw).digest("hex"),
            packed,
          ).lastInsertRowid,
        );
        for (const [index, values] of buffer.entries()) {
          if (indexed)
            insert.run(
              ...values.filter((_, i) => i !== payloadColumn),
              chunkId,
              index,
              payloadColumn,
            );
          else insert.run(...values);
        }
        buffer = [];
        encodedRows = [];
        rawBytes = 0;
        chunks++;
      };
      // Discover retained rowids through narrow indexes, avoiding a scan of discarded payloads.
      const condition =
        name === "orchestration_events"
          ? ` WHERE sequence IN (
        SELECT sequence FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence WHERE application_event_version != 2
        UNION ALL
        SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence WHERE aggregate_kind != 'thread' AND application_event_version = 2
        UNION ALL
        SELECT sequence FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx WHERE application_event_version=2 AND aggregate_kind='thread' AND event_type='thread.created'
      )`
          : "";
      checkDeadline();
      const read = source.prepare(
        `SELECT ${columns.map(quoted).join(",")} FROM ${quoted(name)}${condition}`,
      );
      read.setReturnArrays(true);
      for (const entry of read.iterate()) {
        const values = entry as unknown as NodeSqlite.SQLInputValue[];
        if (
          name === "orchestration_v2_projection_turn_items" &&
          values[columns.indexOf("status")] === "completed" &&
          ["command_execution", "dynamic_tool"].includes(String(values[columns.indexOf("type")])) &&
          String(values[columns.indexOf("updated_at")]) < cutoff &&
          values[columns.indexOf("run_id")] !==
            latestRuns.get(String(values[columns.indexOf("thread_id")]))
        ) {
          const item = JSON.parse(String(values[payloadColumn]));
          const retained = retainToolOutput(item, now);
          if (item !== retained) {
            values[payloadColumn] = JSON.stringify(retained);
            trimmedOutputCount++;
          }
        }
        const encoded = JSON.stringify(encodeSqliteRow(values));
        hash.update(encoded);
        hash.update("\n");
        rowCount++;
        if (baseline) {
          buffer.push(values);
          encodedRows.push(encoded);
          rawBytes += Buffer.byteLength(encoded);
          if (buffer.length >= 100 || rawBytes >= 262144) flush();
        } else insert.run(...values);
        const current = Date.now();
        if (rowCount % 100 === 0 && current - lastProgress > 1000) {
          checkDeadline();
          const space = NodeFS.statfsSync(input.destination);
          if (space.bavail * space.bsize < 512 * 1024 * 1024)
            throw new Error("Compaction reached the free-space reserve");
          if (current - lastProgress > 15000) {
            input.onProgress?.({
              table: name,
              rows: rowCount,
              elapsedSeconds: (current - started) / 1000,
              fileBytes: NodeFS.statSync(input.destination).size,
            });
            lastProgress = current;
          }
        }
      }
      checkDeadline();
      flush();
      const sha256 = hash.digest("hex");
      if (baseline) {
        const previousSchema = hasBaseline
          ? source
              .prepare("SELECT schema_sql FROM orchestration_storage_tables WHERE table_name=?")
              .get(name)?.schema_sql
          : undefined;
        saveTable.run(
          name,
          JSON.stringify(columns),
          previousSchema ?? String(definition.sql),
          rowCount,
          sha256,
        );
      }
      if (name === "orchestration_events") copiedEvents = rowCount;
      reports.push({ name, rows: rowCount, chunks, sha256 });
    }
    if (hasBaseline) {
      const copyStream = target.prepare(
        "INSERT INTO orchestration_storage_streams VALUES (?,?,?,?)",
      );
      for (const row of source.prepare("SELECT * FROM orchestration_storage_streams").iterate()) {
        copyStream.run(
          row.aggregate_kind!,
          row.stream_id!,
          row.stream_version!,
          row.agent_sequence!,
        );
      }
    }
    checkDeadline();
    const agentHeads = new Map<string, number>();
    for (const row of source
      .prepare(
        "SELECT stream_id,MAX(sequence) AS sequence FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence WHERE application_event_version=2 AND aggregate_kind='thread' GROUP BY stream_id",
      )
      .iterate()) {
      agentHeads.set(String(row.stream_id), Number(row.sequence));
    }
    const streams = source.prepare(
      "SELECT aggregate_kind,stream_id,MAX(stream_version) AS version FROM orchestration_events INDEXED BY idx_orch_events_stream_version GROUP BY aggregate_kind,stream_id",
    );
    const saveStream = target.prepare(
      `INSERT INTO orchestration_storage_streams VALUES (?,?,?,?) ON CONFLICT(aggregate_kind,stream_id) DO UPDATE SET stream_version=MAX(stream_version,excluded.stream_version),agent_sequence=MAX(agent_sequence,excluded.agent_sequence)`,
    );
    for (const row of streams.iterate())
      saveStream.run(
        row.aggregate_kind!,
        row.stream_id!,
        row.version!,
        row.aggregate_kind === "thread" ? (agentHeads.get(String(row.stream_id)) ?? 0) : 0,
      );
    target
      .prepare("INSERT INTO orchestration_storage_baseline VALUES (1,1,?,?,?,?)")
      .run(appHead, agentHead, now, JSON.stringify(TOOL_OUTPUT_RETENTION));
    const highWater = scalar(
      source,
      "SELECT seq FROM sqlite_sequence WHERE name='orchestration_events'",
    );
    target
      .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='orchestration_events'")
      .run(highWater);
    // SQLite evaluates virtual columns even while building unrelated scalar indexes.
    // Expanding every historical JSON string in one native call retains gigabytes of V8
    // handles until the call returns. All indexes on compressed tables use scalar columns;
    // their keys are independent of this temporary value. The subsequent row verifier
    // checks actual chunk payloads and coordinates through a fresh real reader.
    // Keep all three parameters: SQLite registers overloads by arity.
    target.function(
      "t3_read_payload",
      { deterministic: true },
      (_chunkId, _rowIndex, _columnIndex) => "{}",
    );
    if (searchTable) target.exec(String(searchTable.sql));
    for (const row of schemas)
      if (row.type !== "table") {
        checkDeadline();
        if (
          row.type === "index" &&
          /payload_json/i.test(String(row.sql)) &&
          COMPRESSED_PROJECTION_TABLES.some((table) => String(row.sql).includes(table))
        ) {
          throw new Error("Compressed storage does not support JSON expression indexes");
        }
        input.onProgress?.({
          table: `schema:${row.name}`,
          rows: 0,
          elapsedSeconds: (Date.now() - started) / 1000,
          fileBytes: NodeFS.statSync(input.destination).size,
        });
        target.exec(String(row.sql));
      }
    registerCompressedSqlite(target);
    if (searchTable) {
      let cursor = 0;
      const page = target.prepare(
        "SELECT rowid FROM orchestration_v2_projection_messages WHERE rowid > ? ORDER BY rowid LIMIT 100",
      );
      const indexPage = target.prepare(`INSERT INTO orchestration_v2_message_search(rowid, text)
        SELECT messages.rowid, ${indexedMessageTextSql("messages.payload_json")}
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.rowid > ? AND messages.rowid <= ? AND ${indexedMessageConditionSql()}
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL`);
      while (true) {
        checkDeadline();
        const rows = page.all(cursor);
        if (rows.length === 0) break;
        const end = Number(rows[rows.length - 1]!.rowid);
        indexPage.run(cursor, end);
        cursor = end;
      }
    }
    checkDeadline();
    target.exec("COMMIT; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    input.onProgress?.({
      table: "quick_check",
      rows: 0,
      elapsedSeconds: (Date.now() - started) / 1000,
      fileBytes: NodeFS.statSync(input.destination).size,
    });
    if (Object.values(target.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok")
      throw new Error("Compacted database failed SQLite verification");
    checkDeadline();
    const removedEventCount =
      scalar(source, "SELECT COUNT(*) FROM orchestration_events") - copiedEvents;
    target.close();
    destination = undefined;
    const descriptor = NodeFS.openSync(input.destination, "r");
    try {
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
    succeeded = true;
    return {
      sourceBytes: NodeFS.statSync(input.source).size,
      destinationBytes: NodeFS.statSync(input.destination).size,
      elapsedSeconds: (Date.now() - started) / 1000,
      applicationSequence: appHead,
      agentSequence: agentHead,
      removedEventCount,
      trimmedOutputCount,
      tables: reports,
    };
  } finally {
    destination?.close();
    source.close();
    if (!succeeded && NodeFS.existsSync(input.destination)) NodeFS.unlinkSync(input.destination);
  }
}
