import { STORAGE_SCHEMA } from "@t3tools/shared/sqliteStorageSchema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of STORAGE_SCHEMA) yield* sql.unsafe(statement);
});
