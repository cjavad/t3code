// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - standalone watchdog must run outside the synchronous SQLite worker.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { compactSqliteDatabase } from "@t3tools/shared/compactSqliteDatabase";

const worker = process.argv[2] === "--worker";
const [source, destination] = process.argv.slice(worker ? 3 : 2);
if (!source || !destination)
  throw new Error(
    "Usage: node apps/server/scripts/compact-db.ts SOURCE.sqlite NEW-DESTINATION.sqlite",
  );
const timeoutMs = Number(process.env.T3_DB_COMPACTION_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  throw new Error("Invalid compaction timeout");
if (NodePath.resolve(source) === NodePath.resolve(destination) || NodeFS.existsSync(destination))
  throw new Error("Destination must be a new file separate from the source");

if (worker) {
  const report = compactSqliteDatabase({
    source,
    destination,
    timeoutMs,
    onProgress: (progress) => process.stdout.write(JSON.stringify(progress) + "\n"),
  });
  process.stdout.write(JSON.stringify(report) + "\n");
} else {
  // Native SQLite calls are synchronous. A separate watchdog enforces the deadline even
  // during a single expensive query, index build or integrity check.
  const stagingDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(NodePath.resolve(destination)), ".t3-compact-"),
  );
  const stagingFile = NodePath.join(stagingDirectory, "state.sqlite");
  const child = NodeChildProcess.fork(
    NodeURL.fileURLToPath(import.meta.url),
    ["--worker", source, stagingFile],
    {
      stdio: "inherit",
    },
  );
  const deadline = setTimeout(() => {
    process.stderr.write("Compaction timed out; source is unchanged\n");
    child.kill("SIGTERM");
  }, timeoutMs);
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      // Publish atomically without overwriting a destination created by another process.
      if (code === 0) NodeFS.linkSync(stagingFile, destination);
      process.exitCode = code ?? 1;
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    } finally {
      NodeFS.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });
  child.on("error", (error) => {
    clearTimeout(deadline);
    process.stderr.write(error.message + "\n");
    NodeFS.rmSync(stagingDirectory, { recursive: true, force: true });
    process.exitCode = 1;
  });
}
