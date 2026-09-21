import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { AuthUserRepository, layer as authUsersLayer } from "./AuthUsers.ts";
import { runMigrations } from "./Migrations.ts";

const testLayer = authUsersLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.layer(testLayer)("AuthUserRepository", (it) => {
  it.effect("creates one stable user row for a subject", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* AuthUserRepository;
      const first = yield* repository.ensureForSubject({
        subject: "johan",
        now: "2026-09-18T00:00:00.000Z",
      });
      const second = yield* repository.ensureForSubject({
        subject: "johan",
        now: "2026-09-19T00:00:00.000Z",
      });

      assert.equal(first.id, "user:johan");
      assert.equal(second.id, first.id);
      assert.equal(DateTime.formatIso(second.createdAt), DateTime.formatIso(first.createdAt));
      assert.deepEqual(yield* repository.getBySubject("missing"), null);
    }),
  );
});
