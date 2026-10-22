import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubGraphQlClient from "@t3tools/source-control-github/server/gitHubGraphQlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GitIdentityError } from "@t3tools/contracts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
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
    const api = yield* GitHubRest.GitHubRest.pipe(
      Effect.provide(
        Layer.mergeAll(GitHubRest.layer, GitHubGraphQlClient.layer)
          .pipe(Layer.provideMerge(GitHubApi.layer))
          .pipe(
            Layer.provideMerge(
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
    ]);
    yield* binding.withSubject("alice", read);
    yield* binding.withSubject("bob", read);
    tokens.set("alice", "rotated-token");
    yield* binding.withSubject("alice", read);
    assert.deepStrictEqual(headers, [
      "Bearer alice-token",
      "Bearer bob-token",
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

it.effect("verifies the page account and writes PR actions under the personal credential", () =>
  Effect.gen(function* () {
    const tokens = new Map([
      ["alice", "alice-token"],
      ["bob", "bob-token"],
    ]);
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const binding = yield* GitHubIdentity.make.pipe(
      Effect.provide(
        Layer.mock(GitIdentityService)({
          resolveGitHubToken: (subject) => Effect.sync(() => Redacted.make(tokens.get(subject)!)),
        }),
      ),
    );
    const cli = yield* GitHubPullRequestApi.make.pipe(
      Effect.provide(
        Layer.mergeAll(GitHubRest.layer, GitHubGraphQlClient.layer)
          .pipe(Layer.provideMerge(GitHubApi.layer))
          .pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.mock(GitHubCredentials.GitHubCredentials)({
                  get: () => Effect.die("server credential must not be selected"),
                }),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    requests.push({
                      url: request.url,
                      authorization: request.headers.authorization,
                    });
                    const alice = request.headers.authorization?.includes("alice") === true;
                    const body = request.url.endsWith("/user")
                      ? { id: alice ? 101 : 202, login: alice ? "alice" : "bob" }
                      : {
                          data: {
                            repository: { pullRequest: { id: "PR_1" } },
                            addComment: { clientMutationId: null },
                          },
                        };
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(JSON.stringify(body), {
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
            Layer.merge(TestSourceControlHost.layer()),
            Layer.provideMerge(NodeServices.layer),
          ),
      ),
    );
    const readAndWrite = (subject: string, expectedAccountId: string) =>
      binding.withSubject(
        subject,
        cli.withVerifiedCredential({ cwd: "/repo", host: "github.com" }, (identity) =>
          Effect.gen(function* () {
            assert.strictEqual(identity.accountId, expectedAccountId);
            assert.strictEqual(identity.viewer, subject);
            assert.strictEqual(
              yield* SourceControlRateLimit.CredentialScope,
              identity.credentialFingerprint,
            );
            yield* cli.commentOnPullRequest({
              cwd: "/repo",
              host: "github.com",
              repository: "acme/web",
              number: 1,
              body: "fixture",
            });
            return identity.credentialFingerprint;
          }),
        ),
      );
    const first = yield* readAndWrite("alice", "101");
    yield* readAndWrite("bob", "202");
    tokens.set("alice", "alice-rotated");
    const rotated = yield* readAndWrite("alice", "101");
    assert.notStrictEqual(first, rotated);
    assert.deepStrictEqual(
      requests
        .filter((request) => request.url.endsWith("/user"))
        .map((request) => request.authorization),
      ["Bearer alice-token", "Bearer bob-token", "Bearer alice-rotated"],
    );
    assert.deepStrictEqual(
      requests
        .filter((request) => request.url.endsWith("/graphql"))
        .map((request) => request.authorization),
      ["Bearer alice-token", "Bearer alice-token", "Bearer bob-token", "Bearer alice-rotated"],
    );
  }),
);

it.effect(
  "pins streamed operations to the person and preserves fallback without a personal token",
  () =>
    Effect.gen(function* () {
      const binding = yield* GitHubIdentity.make.pipe(
        Effect.provide(
          Layer.mock(GitIdentityService)({
            resolveGitHubToken: (subject) =>
              Effect.succeed(subject === "alice" ? Redacted.make("alice-token") : null),
          }),
        ),
      );
      const read = Effect.all([
        GitHubApi.PinnedGitHubCredential,
        SourceControlRateLimit.CredentialScope,
      ]);
      const rows = yield* binding
        .withSubjectStream("alice", Stream.fromEffect(read))
        .pipe(Stream.runCollect);
      assert.strictEqual(Redacted.value(rows[0]![0]!.token), "alice-token");
      assert.strictEqual(rows[0]![1], rows[0]![0]!.credentialFingerprint);
      const ambient = {
        host: "github.com",
        token: Redacted.make("server-token"),
        credentialFingerprint: "server-fingerprint",
      };
      const fallback = yield* binding
        .withSubject("no-token", read)
        .pipe(
          Effect.provideService(GitHubApi.PinnedGitHubCredential, ambient),
          Effect.provideService(SourceControlRateLimit.CredentialScope, "server-fingerprint"),
        );
      assert.strictEqual(fallback[0], ambient);
      assert.strictEqual(fallback[1], "server-fingerprint");
    }),
);
