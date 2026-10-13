/**
 * The T3 MCP credential each thread's provider session should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly setGitExecutionEnvironment: (
      threadId: ThreadId,
      environment: Readonly<Record<string, string>>,
    ) => Effect.Effect<void>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const gitEnvironments = yield* Ref.make(new Map<ThreadId, Readonly<Record<string, string>>>());
  return McpProviderSessions.of({
    setGitExecutionEnvironment: (threadId, environment) =>
      Ref.update(gitEnvironments, (current) => new Map(current).set(threadId, environment)),
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) =>
      Effect.gen(function* () {
        const session = (yield* Ref.get(sessions)).get(threadId);
        const environment = (yield* Ref.get(gitEnvironments)).get(threadId);
        return session === undefined || environment === undefined
          ? session
          : { ...session, gitExecutionEnvironment: environment };
      }),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
