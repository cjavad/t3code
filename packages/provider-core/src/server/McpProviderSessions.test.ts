import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "./McpProviderSessions.ts";

it.effect("keeps assigned identities through MCP rotation and isolates service instances", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions.pipe(
      Effect.provide(McpProviderSessions.layer),
    );
    const isolated = yield* McpProviderSessions.McpProviderSessions.pipe(
      Effect.provide(McpProviderSessions.layer),
    );
    const alice = ThreadId.make("alice-thread");
    const bob = ThreadId.make("bob-thread");
    const config = (threadId: ThreadId, authorizationHeader: string) => ({
      threadId,
      authorizationHeader,
      environmentId: EnvironmentId.make("fixture"),
      providerInstanceId: ProviderInstanceId.make("fixture"),
      providerSessionId: "fixture",
      endpoint: "http://localhost/mcp",
      browserToolsAvailable: false,
    });
    yield* sessions.setGitExecutionEnvironment(alice, {
      GH_TOKEN: "alice-token",
      GIT_AUTHOR_EMAIL: "alice@example.com",
    });
    yield* sessions.setGitExecutionEnvironment(bob, { GH_TOKEN: "bob-token" });
    yield* sessions.set(config(alice, "old-mcp-token"));
    yield* sessions.set(config(bob, "bob-mcp-token"));
    yield* sessions.clear(alice);
    yield* sessions.set(config(alice, "new-mcp-token"));
    assert.strictEqual((yield* sessions.read(alice))?.authorizationHeader, "new-mcp-token");
    assert.strictEqual(
      (yield* sessions.read(alice))?.gitExecutionEnvironment?.GH_TOKEN,
      "alice-token",
    );
    assert.strictEqual((yield* sessions.read(bob))?.gitExecutionEnvironment?.GH_TOKEN, "bob-token");
    assert.strictEqual(yield* isolated.read(alice), undefined);
    yield* sessions.setGitExecutionEnvironment(alice, { GH_TOKEN: "rotated-alice-token" });
    assert.strictEqual(
      (yield* sessions.read(alice))?.gitExecutionEnvironment?.GH_TOKEN,
      "rotated-alice-token",
    );
  }),
);
