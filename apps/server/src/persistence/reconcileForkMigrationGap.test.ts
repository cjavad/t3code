import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import AuthUsers from "./Migrations/063_AuthUsers.ts";
import AuthCloudDevices from "./Migrations/064_AuthCloudDevices.ts";
it.effect("fills upstream migrations below the released fork ledger and preserves auth", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "63_AuthUsers": AuthUsers,
        "64_AuthCloudDevices": AuthCloudDevices,
      }),
    });
    yield* sql`INSERT INTO auth_users VALUES ('user-1', 'owner', 'Owner', 'before', 'before')`;
    const auth = yield* sql`SELECT * FROM auth_users`;
    const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 57 }), [
      [57, "ScheduledTaskWebhooks"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'scheduled_task_webhook_relay_deliveries'`,
      [],
    );
    assert.deepStrictEqual(yield* runMigrations(), [
      [58, "WebhookRelayDeliveries"],
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "PullRequestReviewGuides"],
    ]);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM auth_users`, auth);
    const after = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      after.filter((row) => row.migration_id < 57 || row.migration_id >= 63),
      ledger,
    );
    assert.deepStrictEqual(
      after.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
    assert.strictEqual(
      (yield* sql`SELECT webhook_token, webhook_secret FROM scheduled_tasks`).length,
      0,
    );
    assert.strictEqual(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'scheduled_task_webhook_relay_deliveries'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
