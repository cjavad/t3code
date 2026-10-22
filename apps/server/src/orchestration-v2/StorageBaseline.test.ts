// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  TurnItemId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { compactSqliteDatabase } from "@t3tools/shared/compactSqliteDatabase";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Events from "./EventStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Sink from "./EventSink.ts";
import * as Maintenance from "./ProjectionMaintenance.ts";

function databaseLayer(path: string) {
  const db = Sqlite.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.mergeAll(Events.layer, Projections.layer).pipe(Layer.provideMerge(db));
  return Layer.mergeAll(Sink.layer, Maintenance.layer).pipe(Layer.provideMerge(stores));
}
const threadId = ThreadId.make("thread:storage-test");
const now = DateTime.makeUnsafe("2026-09-01T00:00:00Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const item = {
  id: TurnItemId.make("item:storage"),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "command_execution" as const,
  input: "large historical command",
  output: "full output ".repeat(2000),
  exitCode: 0,
};
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project:storage"),
  createdBy: "user",
  creationSource: "web",
  title: "baseline",
  linkedPullRequest: {
    projectId: ProjectId.make("project:storage"),
    repository: "acme/web",
    number: 42,
    url: "https://github.com/acme/web/pull/42",
  },
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

it.effect(
  "reopens a compacted database, appends past the baseline, rebuilds and repacks without losing tail state",
  () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-"));
      const source = NodePath.join(dir, "source.sqlite"),
        compacted = NodePath.join(dir, "compacted.sqlite"),
        repacked = NodePath.join(dir, "repacked.sqlite");
      try {
        yield* Effect.gen(function* () {
          const sink = yield* Sink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("storage:create"),
                type: "thread.created",
                threadId,
                providerInstanceId,
                occurredAt: now,
                payload: thread,
              },
              {
                id: EventId.make("storage:item"),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: item,
              },
              {
                id: EventId.make("storage:baseline"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...thread, title: "compacted" },
              },
            ],
          });
        }).pipe(Effect.provide(databaseLayer(source)));
        const report = compactSqliteDatabase({ source, destination: compacted });
        expect(report.removedEventCount).toBe(2);
        expect(report.trimmedOutputCount).toBe(1);
        yield* Effect.gen(function* () {
          const sink = yield* Sink.EventSinkV2;
          const events = yield* Events.EventStoreV2;
          const projections = yield* Projections.ProjectionStoreV2;
          const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
          expect((yield* maintenance.verify).valid).toBe(true);
          expect((yield* projections.getThreadProjection(threadId)).thread.title).toBe("compacted");
          expect(yield* events.latestSequence()).toBe(report.agentSequence);
          expect((yield* projections.getThreadProjection(threadId)).turnItems[0]).toHaveProperty(
            "outputRetention.policyVersion",
            1,
          );
          yield* sink.write({
            events: [
              {
                id: EventId.make("storage:reimport"),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: item,
              },
            ],
          });
          expect((yield* maintenance.rebuild).valid).toBe(true);
          expect(
            (yield* projections.getThreadProjection(threadId)).thread.pullRequests?.[0],
          ).toMatchObject({ number: 42, host: "github.com" });
          const retainedItem = (yield* projections.getThreadProjection(threadId)).turnItems[0]!;
          expect(retainedItem).toHaveProperty("outputRetention.policyVersion", 1);
          expect(retainedItem).not.toHaveProperty("output", item.output);
          const appended = yield* sink.write({
            events: [
              {
                id: EventId.make("storage:tail"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...thread, title: "tail" },
              },
            ],
          });
          expect(appended[0]!.sequence).toBeGreaterThan(report.applicationSequence);
          expect((yield* maintenance.rebuild).valid).toBe(true);
          expect((yield* projections.getThreadProjection(threadId)).thread.title).toBe("tail");

          // A corrupt recovery chunk must roll the whole rebuild transaction back.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE orchestration_storage_chunks SET sha256 = 'corrupt' WHERE table_name = 'orchestration_v2_projection_threads'`;
          const outcome = yield* maintenance.rebuild.pipe(Effect.exit);
          expect(outcome._tag).toBe("Failure");
          expect((yield* projections.getThreadProjection(threadId)).thread.title).toBe("tail");
        }).pipe(Effect.provide(databaseLayer(compacted)));
        // Repack from an independently compacted copy to avoid the intentionally corrupt fixture.
        const healthy = NodePath.join(dir, "healthy.sqlite");
        compactSqliteDatabase({ source, destination: healthy });
        const next = compactSqliteDatabase({ source: healthy, destination: repacked });
        expect(next.agentSequence).toBe(report.agentSequence);
        yield* Effect.gen(function* () {
          const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
          expect((yield* maintenance.rebuild).valid).toBe(true);
        }).pipe(Effect.provide(databaseLayer(repacked)));
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
);
