// @effect-diagnostics nodeBuiltinImport:off - credential namespaces match GitHubCredentials.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2ThreadGitIdentity } from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import { AuthUserRepository } from "../persistence/AuthUsers.ts";
import { GitIdentityService } from "./GitIdentityService.ts";

export const credentialForToken = (token: Redacted.Redacted<string>) => ({
  host: "github.com",
  token,
  credentialFingerprint: `github.com:${NodeCrypto.createHash("sha256").update(Redacted.value(token), "utf8").digest("hex")}`,
});

/** Read on each operation so credential rotation does not require reconnecting. */
export const withSubject = Effect.fn("GitHubIdentity.withSubject")(function* <A, E, R>(
  subject: string,
  operation: Effect.Effect<A, E, R>,
) {
  const identities = yield* Effect.serviceOption(GitIdentityService);
  if (Option.isNone(identities)) return yield* operation;
  // A storage fault must not quietly execute as the server's account.
  const token = yield* identities.value.resolveGitHubToken(subject).pipe(Effect.orDie);
  if (token === null) return yield* operation;
  const credential = credentialForToken(token);
  return yield* operation.pipe(
    Effect.provideService(GitHubApi.PinnedGitHubCredential, credential),
    Effect.provideService(SourceControlRateLimit.CredentialScope, credential.credentialFingerprint),
  );
});

/** Background readers follow the persisted thread owner, not the triggering session. */
export const withThreadIdentity = Effect.fn("GitHubIdentity.withThreadIdentity")(function* <
  A,
  E,
  R,
>(
  identity: OrchestrationV2ThreadGitIdentity | null | undefined,
  operation: Effect.Effect<A, E, R>,
) {
  if (identity == null) return yield* operation;
  const users = yield* Effect.serviceOption(AuthUserRepository);
  if (Option.isNone(users)) return yield* operation;
  const user = yield* users.value.getById(identity.userId).pipe(Effect.orDie);
  if (user === null)
    return yield* Effect.die(new Error("The thread Git identity no longer exists."));
  return yield* withSubject(user.subject, operation);
});

/** Capture only identity services when building a layer; keep each caller's API context. */
export const make = Effect.gen(function* () {
  const identities = yield* Effect.serviceOption(GitIdentityService);
  const users = yield* Effect.serviceOption(AuthUserRepository);
  const bind = <A, E, R>(operation: Effect.Effect<A, E, R>) => {
    const withIdentities = Option.isSome(identities)
      ? operation.pipe(Effect.provideService(GitIdentityService, identities.value))
      : operation;
    return Option.isSome(users)
      ? withIdentities.pipe(Effect.provideService(AuthUserRepository, users.value))
      : withIdentities;
  };
  return {
    withSubjectStream: <A, E, R>(subject: string, stream: Stream.Stream<A, E, R>) =>
      Stream.unwrap(
        bind(
          withSubject(
            subject,
            Effect.context<R>().pipe(
              Effect.map((context) => stream.pipe(Stream.provideContext(context))),
            ),
          ),
        ),
      ),
    withSubject: <A, E, R>(subject: string, operation: Effect.Effect<A, E, R>) =>
      bind(withSubject(subject, operation)),
    withThreadIdentity: <A, E, R>(
      identity: OrchestrationV2ThreadGitIdentity | null | undefined,
      operation: Effect.Effect<A, E, R>,
    ) => bind(withThreadIdentity(identity, operation)),
  };
});
