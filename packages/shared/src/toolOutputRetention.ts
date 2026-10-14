import { compactDynamicToolOutput } from "./toolOutput.ts";

export const TOOL_OUTPUT_RETENTION = { version: 1, minimumAgeDays: 7, maxTextBytes: 8192 } as const;
export interface OutputRetention {
  readonly policyVersion: 1;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly compactedAt: string;
}
interface RetainableItem {
  readonly type: string;
  readonly status: string;
  readonly output?: unknown;
  readonly outputOmitted?: boolean | undefined;
  readonly outputIndicatesFailure?: boolean | undefined;
  readonly exitCode?: number | undefined;
  readonly outputRetention?: OutputRetention | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (text: string) => encoder.encode(text);
const json = (value: unknown) => JSON.stringify(value);
const textKeys = new Set(["text", "stdout", "stderr", "output"]);

function excerpt(text: string, budget: number): string {
  const bytes = utf8(text);
  if (bytes.length <= budget) return text;
  const marker = `\n[T3: historical tool output shortened from ${bytes.length} bytes; full output was removed.]\n`;
  const room = Math.max(0, budget - utf8(marker).length);
  const head = Math.floor(room / 2);
  // Ignore incomplete code points at either boundary without emitting replacement characters.
  const clean = (bytes: Uint8Array) => decoder.decode(bytes).replace(/^\uFFFD+|\uFFFD+$/gu, "");
  return (
    clean(bytes.subarray(0, head)) + marker + clean(bytes.subarray(bytes.length - (room - head)))
  );
}

/** Keep object shape, flags, identifiers, app references and binary blocks; shorten only text. */
function retainStructured(value: unknown, budget: { bytes: number }, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => retainStructured(entry, budget, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (textKeys.has(key) && typeof entry === "string") {
        const retained = excerpt(entry, Math.max(256, budget.bytes));
        budget.bytes = Math.max(0, budget.bytes - utf8(retained).length);
        return [key, retained];
      }
      return [key, retainStructured(entry, budget, depth + 1)];
    }),
  );
}

/** Eligibility (age/newest run) is decided by the caller. Never trim unfinished or failed tools. */
export function retainToolOutput<A extends RetainableItem>(item: A, now: string): A {
  if (
    item.status !== "completed" ||
    !["command_execution", "dynamic_tool"].includes(item.type) ||
    item.output === undefined ||
    item.outputOmitted === true ||
    item.outputIndicatesFailure === true ||
    (item.exitCode !== undefined && item.exitCode !== 0) ||
    compactDynamicToolOutput(item.output)?.isError === true
  )
    return item;
  const original = typeof item.output === "string" ? item.output : json(item.output);
  if (original === undefined || utf8(original).length <= TOOL_OUTPUT_RETENTION.maxTextBytes)
    return item;
  let output: unknown;
  if (typeof item.output === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.output);
    } catch {
      /* Plain text output. */
    }
    output =
      parsed !== null && typeof parsed === "object"
        ? json(retainStructured(parsed, { bytes: TOOL_OUTPUT_RETENTION.maxTextBytes }))
        : excerpt(item.output, TOOL_OUTPUT_RETENTION.maxTextBytes);
  } else {
    output = retainStructured(item.output, { bytes: TOOL_OUTPUT_RETENTION.maxTextBytes });
  }
  const retained = typeof output === "string" ? output : json(output);
  if (retained === original) return item;
  return {
    ...item,
    output,
    outputRetention: {
      policyVersion: 1,
      originalBytes: utf8(original).length,
      retainedBytes: utf8(retained).length,
      compactedAt: now,
    },
  };
}
