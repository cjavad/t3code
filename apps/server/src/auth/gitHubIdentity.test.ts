import { assert, it } from "@effect/vitest";
import { GitIdentityError } from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { GitIdentityService } from "./GitIdentityService.ts";
import * as GitHubIdentity from "./gitHubIdentity.ts";

it.effect("binds REST and GraphQL to each person and rereads rotated tokens without gh", () =>
  Effect.gen(function* () {
    const tokens = new Map([
      ["alice", "alice-token"],
      ["bob", "bob-token"],
    ]);
    const headers: string[] = [];
    const binding = yield* GitHubIdentity.make.pipe(
      Effect.provide(
        Layer.mock(GitIdentityService)({
          resolveGitHubToken: (subject) => Effect.sync(() => Redacted.make(tokens.get(subject)!)),
        }),
      ),
    );
    const api = yield* GitHubApi.GitHubApi.pipe(
      Effect.provide(
        GitHubApi.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(GitHubCredentials.GitHubCredentials)({
                get: () => Effect.die("ambient credential must not be read"),
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  headers.push(request.headers.authorization!);
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response('{"data":{}}', {
                        headers: { "content-type": "application/json" },
                      }),
                    ),
                  );
                }),
              ),
              GitHubQuota.layer,
              SourceControlRateLimit.layer,
            ),
          ),
        ),
      ),
    );
    const read = Effect.all([
      api.rest({ host: "github.com", operation: "fixture", path: "repos/acme/web/pulls/1" }),
      api.graphql({
        host: "github.com",
        operation: "fixture",
        query: "query { viewer { login } }",
      }),
    ]);
    yield* binding.withSubject("alice", read);
    yield* binding.withSubject("bob", read);
    tokens.set("alice", "rotated-token");
    yield* binding.withSubject("alice", read);
    assert.deepStrictEqual(headers, [
      "Bearer alice-token",
      "Bearer alice-token",
      "Bearer bob-token",
      "Bearer bob-token",
      "Bearer rotated-token",
      "Bearer rotated-token",
    ]);
    const fingerprint = yield* binding.withSubject("alice", SourceControlRateLimit.CredentialScope);
    assert.match(fingerprint, /^github\.com:[a-f0-9]{64}$/u);
    assert.ok(!fingerprint.includes("rotated-token"));
  }),
);

it.effect("fails closed when personal token storage fails", () =>
  Effect.gen(function* () {
    let ran = false;
    const exit = yield* Effect.exit(
      GitHubIdentity.withSubject(
        "alice",
        Effect.sync(() => {
          ran = true;
        }),
      ).pipe(
        Effect.provide(
          Layer.mock(GitIdentityService)({
            resolveGitHubToken: () =>
              Effect.fail(
                new GitIdentityError({ reason: "storage", detail: "fixture storage failure" }),
              ),
          }),
        ),
      ),
    );
    assert.strictEqual(exit._tag, "Failure");
    assert.strictEqual(ran, false);
  }),
);
