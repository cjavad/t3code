import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import AuthUsers from "./Migrations/1001_AuthUsers.ts";
import AuthCloudDevices from "./Migrations/1002_AuthCloudDevices.ts";
import CompressedStorage from "./Migrations/1003_CompressedStorage.ts";

it.effect.each([false, true])(
  "moves the released fork ledger without skipping upstream migrations (compressed=%s)",
  (compressed) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const migrations: Record<
        string,
        Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
      > = {
        "63_AuthUsers": AuthUsers,
        "64_AuthCloudDevices": AuthCloudDevices,
      };
      if (compressed) migrations["65_CompressedStorage"] = CompressedStorage;
      yield* Migrator.make({})({ loader: Migrator.fromRecord(migrations) });
      yield* sql`INSERT INTO auth_users VALUES ('user-javad','javad','Javad','before','before')`;
      const auth = yield* sql`SELECT * FROM auth_users`;
      const dates = yield* sql<{
        name: string;
        created_at: string;
      }>`SELECT name,created_at FROM effect_sql_migrations WHERE migration_id IN (63,64,65)`;
      const result = yield* runMigrations();
      assert.ok(result.some(([id]) => id === 62));
      assert.ok(result.some(([id, name]) => id === 63 && name === "DropUnusedV1Projections"));
      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_users`, auth);
      const history = yield* sql<{
        migration_id: number;
        name: string;
        created_at: string;
      }>`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      for (const row of dates)
        assert.equal(history.find((after) => after.name === row.name)?.created_at, row.created_at);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
