// @effect-diagnostics nodeBuiltinImport:off -- SQLite UDFs are synchronous and use the persisted Node crypto digest format.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

export const COMPRESSED_PROJECTION_TABLES = [
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_turn_items",
] as const;

export type StoredValue = string | number | null | { blob: string } | { integer: string };

export function encodeSqliteRow(values: readonly NodeSqlite.SQLInputValue[]): StoredValue[] {
  return values.map((value) => {
    if (typeof value === "bigint") {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : { integer: value.toString() };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
      };
    }
    return value;
  });
}

/** Canonical row encoding shared by the exporter and baseline verifier. */
export const encodeSqliteRowJson = (values: readonly NodeSqlite.SQLInputValue[]) =>
  JSON.stringify(encodeSqliteRow(values));

export function decodeSqliteRow(values: readonly StoredValue[]): NodeSqlite.SQLInputValue[] {
  return values.map((value) => {
    if (value !== null && typeof value === "object") {
      return "blob" in value ? Buffer.from(value.blob, "base64") : BigInt(value.integer);
    }
    return value;
  });
}

function decodeStorageChunkWithCodecs(
  payload: Uint8Array,
  expectedHash: string,
  expectedBytes: number | undefined,
  codecs: typeof NodeZlib,
  crypto: typeof NodeCrypto,
): StoredValue[][] {
  const MAX_CHUNK_BYTES = 256 * 1024 * 1024;
  // Zstandard is available in the supported Node runtimes. Gzip remains readable for older copies.
  const zstd =
    payload[0] === 0x28 && payload[1] === 0xb5 && payload[2] === 0x2f && payload[3] === 0xfd;
  const raw = zstd
    ? codecs.zstdDecompressSync(payload, { maxOutputLength: MAX_CHUNK_BYTES })
    : codecs.gunzipSync(payload, { maxOutputLength: MAX_CHUNK_BYTES });
  if (
    (expectedBytes !== undefined && raw.length !== expectedBytes) ||
    crypto.createHash("sha256").update(raw).digest("hex") !== expectedHash
  ) {
    throw new Error("Compressed database chunk failed verification");
  }
  const rows: unknown = JSON.parse(raw.toString("utf8"));
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        Array.isArray(row) &&
        row.every(
          (value) =>
            value === null ||
            typeof value === "string" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "object" &&
              Object.keys(value).length === 1 &&
              ((typeof value.blob === "string" &&
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  value.blob,
                )) ||
                (typeof value.integer === "string" && /^-?\d+$/.test(value.integer)))),
        ),
    )
  ) {
    throw new Error("Compressed database chunk has invalid rows");
  }
  return rows as StoredValue[][];
}

export function decodeStorageChunk(
  payload: Uint8Array,
  expectedHash: string,
  expectedBytes?: number,
): StoredValue[][] {
  return decodeStorageChunkWithCodecs(payload, expectedHash, expectedBytes, NodeZlib, NodeCrypto);
}

/** Only mutations target the inline column; reads continue using the indexed, generated JSON. */
function rewriteMutation(query: string, table: string): string {
  const target = query.match(/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+["`[]?(\w+)["`\]]?/i);
  if (target?.[1] !== table) return query;
  // Tokenize quoted literals/comments separately so embedded JSON, strings and paths stay intact.
  const tokens =
    query.match(
      /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\b\w+\b|[^\w]/g,
    ) ?? [];
  let insertColumns = /^\s*INSERT/i.test(query);
  let seenTable = false;
  let depth = 0;
  let inSet = false;
  let setDepth = 0;
  return tokens
    .map((token, index) => {
      const word = token.replace(/^["`[]|["`\]]$/g, "");
      if (!seenTable && word === table) {
        seenTable = true;
        return token;
      }
      if (!seenTable) return token;
      if (insertColumns) {
        if (token === "(") depth++;
        if (token === ")" && --depth === 0) insertColumns = false;
        if (word.toLowerCase() === "payload_json") return "t3_payload_inline";
        return token;
      }
      if (token === "(") depth++;
      if (token === ")") depth--;
      if (/^set$/i.test(word)) {
        inSet = true;
        setDepth = depth;
      }
      if (/^(where|returning)$/i.test(word)) inSet = false;
      if (word.toLowerCase() !== "payload_json") return token;
      let previous: string | undefined;
      for (let i = index - 1; i >= 0; i--) {
        if (tokens[i]!.trim() !== "") {
          previous = tokens[i];
          break;
        }
      }
      const next = tokens.slice(index + 1).find((part) => part.trim() !== "");
      if (
        inSet &&
        depth === setDepth &&
        next === "=" &&
        (previous?.toLowerCase() === "set" || previous === ",")
      )
        return "t3_payload_inline";
      return token;
    })
    .join("");
}

/** Install before preparing schema-dependent SQL, including on read-only connections. */
// Self-contained so the same verified reader can be installed in the bundled SQLite worker.
function registerCompressedPayloadReader(
  db: NodeSqlite.DatabaseSync,
  decode: typeof decodeStorageChunk,
): void {
  const CACHE_BYTES = 32 * 1024 * 1024;
  const cache = new Map<number, { rows: StoredValue[][]; bytes: number }>();
  let bytes = 0;
  let read: ReturnType<NodeSqlite.DatabaseSync["prepare"]> | undefined;
  db.function("t3_read_payload", { deterministic: true }, (chunkId, rowIndex, columnIndex) => {
    if (
      typeof chunkId !== "number" ||
      typeof rowIndex !== "number" ||
      typeof columnIndex !== "number" ||
      !Number.isSafeInteger(chunkId) ||
      chunkId < 1 ||
      !Number.isSafeInteger(rowIndex) ||
      rowIndex < 0 ||
      !Number.isSafeInteger(columnIndex) ||
      columnIndex < 0
    ) {
      throw new Error("Compressed database payload has invalid coordinates");
    }
    let entry = cache.get(chunkId);
    if (entry === undefined) {
      read ??= db.prepare(
        "SELECT payload, sha256, raw_bytes FROM orchestration_storage_chunks WHERE chunk_id = ?",
      );
      const chunk = read.get(chunkId);
      if (
        !(chunk?.payload instanceof Uint8Array) ||
        typeof chunk.sha256 !== "string" ||
        typeof chunk.raw_bytes !== "number"
      ) {
        throw new Error("Compressed database payload is missing its chunk");
      }
      entry = {
        rows: decode(chunk.payload, chunk.sha256, chunk.raw_bytes),
        bytes: chunk.raw_bytes,
      };
      if (entry.bytes <= CACHE_BYTES) {
        while (bytes + entry.bytes > CACHE_BYTES && cache.size > 0) {
          const oldest = cache.keys().next().value!;
          bytes -= cache.get(oldest)!.bytes;
          cache.delete(oldest);
        }
        cache.set(chunkId, entry);
        bytes += entry.bytes;
      }
    } else {
      cache.delete(chunkId);
      cache.set(chunkId, entry);
    }
    const value = entry.rows[rowIndex]?.[columnIndex];
    if (typeof value !== "string") throw new Error("Compressed database JSON payload is invalid");
    return value;
  });
}

/** Source for the eval worker; closures are explicitly supplied instead of relying on bundle paths. */
export function compressedSqliteReaderWorkerSource(): string {
  return `
    const decode = (${decodeStorageChunkWithCodecs.toString()});
    (${registerCompressedPayloadReader.toString()})(next, (payload, hash, bytes) =>
      decode(payload, hash, bytes, require("node:zlib"), require("node:crypto")));
  `;
}

/** Install before preparing schema-dependent SQL, including on read-only connections. */
export function registerCompressedSqlite(db: NodeSqlite.DatabaseSync): (query: string) => string {
  registerCompressedPayloadReader(db, decodeStorageChunk);
  const compressed = new Set<string>();
  for (const table of COMPRESSED_PROJECTION_TABLES) {
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)?.sql;
    if (typeof schema === "string" && schema.includes("t3_payload_inline")) compressed.add(table);
  }
  return (query) => {
    const target = query.match(
      /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE)\s+["`[]?(\w+)["`\]]?/i,
    )?.[1];
    return target !== undefined && compressed.has(target) ? rewriteMutation(query, target) : query;
  };
}
