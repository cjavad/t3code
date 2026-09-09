import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Some databases were created from the pre-main-rebase migration numbering,
 * where the V2 migrations occupied IDs 48-59. Those databases already have
 * the V2 tables and indexes but skipped the two projection column migrations
 * that were renumbered to 048 and 049. Add the columns when they are absent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "branch_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN branch_pull_request_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "active_order_key")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN active_order_key TEXT
    `;
  }
});
