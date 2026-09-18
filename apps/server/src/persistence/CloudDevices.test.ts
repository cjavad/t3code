import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { CloudDeviceRepository, layer as cloudDevicesLayer } from "./CloudDevices.ts";
import { runMigrations } from "./Migrations.ts";

const testLayer = cloudDevicesLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

it.layer(testLayer)("CloudDeviceRepository", (it) => {
  it.effect("remembers a device, and only claims one that has connected", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* CloudDeviceRepository;

      yield* repository.recordSeen({
        proofKeyThumbprint: "jkt-1",
        now: "2026-09-18T08:00:00.000Z",
      });
      yield* repository.recordSeen({
        proofKeyThumbprint: "jkt-1",
        now: "2026-09-18T09:00:00.000Z",
      });

      const [seen] = yield* repository.list();
      assert.equal(seen?.proofKeyThumbprint, "jkt-1");
      // Reconnecting keeps the device, and does not resurrect a first-seen time.
      assert.equal(seen?.subject, null);
      assert.equal((yield* repository.list()).length, 1);
      assert.equal(yield* repository.subjectFor("jkt-1"), null);

      // A thumbprint nobody has ever connected with cannot be handed to a user:
      // it would look assigned while matching no real device.
      assert.isFalse(
        yield* repository.assign({
          proofKeyThumbprint: "jkt-unknown",
          subject: "johan",
          assignedBySubject: "johan",
          now: "2026-09-18T10:00:00.000Z",
        }),
      );

      assert.isTrue(
        yield* repository.assign({
          proofKeyThumbprint: "jkt-1",
          subject: "johan",
          assignedBySubject: "javad",
          now: "2026-09-18T10:00:00.000Z",
        }),
      );
      assert.equal(yield* repository.subjectFor("jkt-1"), "johan");

      yield* repository.assign({
        proofKeyThumbprint: "jkt-1",
        subject: null,
        assignedBySubject: "javad",
        now: "2026-09-18T11:00:00.000Z",
      });
      assert.equal(yield* repository.subjectFor("jkt-1"), null);
    }),
  );
});
