import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2ThreadGitIdentity, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { AuthUserRepository } from "../persistence/AuthUsers.ts";
import { makeGitExecutionEnvironment } from "./GitExecutionEnvironment.ts";
import * as GitIdentityService from "./GitIdentityService.ts";

/**
 * Turns the identity a thread carries into the environment its agent processes
 * inherit.
 *
 * Resolution deliberately starts from persisted thread state rather than the
 * connected session: a run started by the scheduler, a resumed thread after a
 * server restart, and a colleague pressing "continue" must all produce commits
 * authored by the person the thread belongs to.
 *
 * A thread with no identity gets an environment with *empty* author and
 * committer variables. That is the point: Git then refuses the commit instead
 * of quietly falling back to whatever global identity the server happens to
 * have configured.
 */
export interface ThreadGitEnvironmentShape {
  /** Environment for a subject acting on its own behalf (interactive Git actions). */
  readonly forSubject: (subject: string) => Effect.Effect<Record<string, string>>;
  /** Environment for the identity persisted on a thread. */
  readonly forThreadIdentity: (
    identity: OrchestrationV2ThreadGitIdentity | null | undefined,
  ) => Effect.Effect<Record<string, string>>;
  /** Resolve that environment and install it for the thread's next provider process. */
  readonly applyToThread: (
    threadId: ThreadId,
    identity: OrchestrationV2ThreadGitIdentity | null | undefined,
  ) => Effect.Effect<void>;
}

export class ThreadGitEnvironment extends Context.Service<
  ThreadGitEnvironment,
  ThreadGitEnvironmentShape
>()("t3/auth/ThreadGitEnvironmentService/ThreadGitEnvironment") {}

const subjectKey = (subject: string): string =>
  NodeCrypto.createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 40);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const gitIdentity = yield* GitIdentityService.GitIdentityService;
  const authUsers = yield* AuthUserRepository;

  // Even without an identity the agent gets its own gh config directory, so a
  // stray `gh auth login` cannot reach the server operator's shared profile.
  const githubConfigDir = (subject: string) =>
    `${config.secretsDir}/gh-config/${subject === "" ? "unassigned" : subjectKey(subject)}`;

  const forSubject: ThreadGitEnvironmentShape["forSubject"] = Effect.fn(
    "ThreadGitEnvironment.forSubject",
  )(function* (subject) {
    const profileResult = yield* Effect.result(gitIdentity.get(subject));
    if (Result.isFailure(profileResult)) {
      // Previously swallowed: a storage fault looked exactly like "no identity
      // configured", and the thread committed as nobody with no explanation.
      yield* Effect.logError("git identity profile could not be read", {
        subject,
        cause: profileResult.failure,
      });
    }
    const profile = Result.isSuccess(profileResult) ? profileResult.success : null;
    let identity: GitIdentityService.GitCommitIdentity | undefined;
    if (profile !== null && profile.signingKey !== null) {
      const identityResult = yield* Effect.result(gitIdentity.resolveCommitIdentity(subject));
      if (Result.isFailure(identityResult)) {
        yield* Effect.logError("git commit identity could not be resolved", {
          subject,
          cause: identityResult.failure,
        });
      } else {
        identity = identityResult.success;
      }
    }
    const tokenResult = yield* Effect.result(gitIdentity.resolveGitHubToken(subject));
    if (Result.isFailure(tokenResult)) {
      yield* Effect.logError("github token could not be read", {
        subject,
        cause: tokenResult.failure,
      });
    }
    const token = Result.isSuccess(tokenResult) ? tokenResult.success : null;
    return makeGitExecutionEnvironment({
      subject,
      githubConfigDir: githubConfigDir(subject),
      ...(identity === undefined ? {} : { identity }),
      ...(token === null ? {} : { githubToken: Redacted.value(token) }),
    });
  });

  const unassignedEnvironment = () =>
    makeGitExecutionEnvironment({ subject: "", githubConfigDir: githubConfigDir("") });

  const forThreadIdentity: ThreadGitEnvironmentShape["forThreadIdentity"] = Effect.fn(
    "ThreadGitEnvironment.forThreadIdentity",
  )(function* (identity) {
    if (identity == null) return unassignedEnvironment();
    const userResult = yield* Effect.result(authUsers.getById(identity.userId));
    if (Result.isFailure(userResult)) {
      yield* Effect.logError("thread git identity user could not be loaded", {
        userId: identity.userId,
        cause: userResult.failure,
      });
      return unassignedEnvironment();
    }
    const user = userResult.success;
    if (user === null) {
      // The assigned user was removed. Committing as the next best thing would
      // forge attribution, so the thread commits as nobody until reassigned.
      yield* Effect.logWarning("thread git identity refers to a user that no longer exists", {
        userId: identity.userId,
      });
      return unassignedEnvironment();
    }
    return yield* forSubject(user.subject);
  });

  const applyToThread: ThreadGitEnvironmentShape["applyToThread"] = Effect.fn(
    "ThreadGitEnvironment.applyToThread",
  )(function* (threadId, identity) {
    const environment = yield* forThreadIdentity(identity);
    McpProviderSession.setGitExecutionEnvironment(threadId, environment);
    if (identity == null) {
      yield* Effect.logWarning("thread has no git identity; agent commits will be refused", {
        threadId,
      });
    }
  });

  return ThreadGitEnvironment.of({ forSubject, forThreadIdentity, applyToThread });
});

export const layer = Layer.effect(ThreadGitEnvironment, make);
