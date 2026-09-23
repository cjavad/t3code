import { assert, it } from "@effect/vitest";

import { makeGitExecutionEnvironment } from "./GitExecutionEnvironment.ts";

it("builds a descendant-safe signed Git environment", () => {
  const environment = makeGitExecutionEnvironment({
    subject: "johan",
    identity: {
      displayName: "Johan Example",
      email: "johan@example.com",
      signingKeyPath: "/srv/secrets/johan.key",
    },
    githubToken: "token-value",
  });

  assert.equal(environment.T3_GIT_SUBJECT, "johan");
  assert.equal(environment.GIT_AUTHOR_NAME, "Johan Example");
  assert.equal(environment.GIT_AUTHOR_EMAIL, "johan@example.com");
  assert.equal(environment.GIT_COMMITTER_NAME, "Johan Example");
  assert.equal(environment.GIT_CONFIG_KEY_2, "commit.gpgsign");
  assert.equal(environment.GIT_CONFIG_VALUE_4, "/srv/secrets/johan.key");
  assert.equal(environment.GH_TOKEN, "token-value");
});

it("prevents an unconfigured subject from inheriting the machine identity", () => {
  const environment = makeGitExecutionEnvironment({ subject: "unknown" });

  assert.equal(environment.GIT_AUTHOR_NAME, "");
  assert.equal(environment.GIT_AUTHOR_EMAIL, "");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "true");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.isUndefined(environment.GH_TOKEN);
});
