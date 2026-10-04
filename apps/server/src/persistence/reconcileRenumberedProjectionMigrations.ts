import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";

/**
 * Preview builds used migration ids 48–62 for V2 before the released build
 * moved the legacy projection migrations back into that range. The migrator
 * keys on ids, so those databases can have the V2 tables while silently
 * skipping the released projection columns and tables. Reconcile the small,
 * additive schema pieces by shape before the normal id-based migrator runs.
 */
export const reconcileRenumberedProjectionMigrations = Effect.fn(
  "reconcileRenumberedProjectionMigrations",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return false;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 48 AND 62
  `;
  // A normal database has the released names at 48 and 49. Only preview
  // databases with the old V2 numbering need this shape-based bridge.
  if (
    history.every(
      (row) => row.migration_id !== 48 || row.name === "ProjectionThreadBranchPullRequest",
    )
  ) {
    return false;
  }
  const projectionThreads = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (projectionThreads.length === 0) return false;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map(({ name }) => name));
  if (!names.has("branch_pull_request_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN branch_pull_request_json TEXT`;
  }
  if (!names.has("active_order_key")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN active_order_key TEXT`;
  }
  if (!names.has("title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }

  const messages = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_messages'
  `;
  if (messages.length > 0) {
    const messageColumns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(projection_thread_messages)`;
    if (!messageColumns.some(({ name }) => name === "context_json")) {
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT`;
    }
  }

  const pullRequests = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_pull_requests'
  `;
  if (pullRequests.length === 0) yield* ProjectionThreadPullRequests;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_files_viewed (
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      viewer TEXT NOT NULL,
      path TEXT NOT NULL,
      revision TEXT,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (provider, host, repository, number, viewer, path)
    ) WITHOUT ROWID
  `;
  return true;
});
