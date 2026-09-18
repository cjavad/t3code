import type { GitCommitIdentity } from "./GitIdentityService.ts";

export interface GitExecutionEnvironmentInput {
  readonly subject: string;
  readonly identity?: GitCommitIdentity;
  readonly githubToken?: string;
  /** Subject-isolated gh config directory, so auth login/logout cannot touch a shared profile. */
  readonly githubConfigDir?: string;
}

/**
 * Environment inherited by an agent and all of its descendants. Git's
 * command-scope config variables are deliberately used in addition to the
 * author/committer variables so shell scripts, hooks, Python helpers, and
 * nested subprocesses all receive the same identity.
 */
export function makeGitExecutionEnvironment(
  input: GitExecutionEnvironmentInput,
): Record<string, string> {
  const environment: Record<string, string> = {
    T3_GIT_SUBJECT: input.subject,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "",
    GIT_COMMITTER_EMAIL: "",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
  };
  if (input.identity !== undefined) {
    environment.GIT_AUTHOR_NAME = input.identity.displayName;
    environment.GIT_AUTHOR_EMAIL = input.identity.email;
    environment.GIT_COMMITTER_NAME = input.identity.displayName;
    environment.GIT_COMMITTER_EMAIL = input.identity.email;
    environment.GIT_CONFIG_COUNT = "5";
    environment.GIT_CONFIG_KEY_0 = "user.name";
    environment.GIT_CONFIG_VALUE_0 = input.identity.displayName;
    environment.GIT_CONFIG_KEY_1 = "user.email";
    environment.GIT_CONFIG_VALUE_1 = input.identity.email;
    environment.GIT_CONFIG_KEY_2 = "commit.gpgsign";
    environment.GIT_CONFIG_VALUE_2 = "true";
    environment.GIT_CONFIG_KEY_3 = "gpg.format";
    environment.GIT_CONFIG_VALUE_3 = "ssh";
    environment.GIT_CONFIG_KEY_4 = "user.signingKey";
    environment.GIT_CONFIG_VALUE_4 = input.identity.signingKeyPath;
  }
  if (input.githubToken !== undefined) {
    // This is scoped to the provider process, never persisted in Git config.
    environment.GH_TOKEN = input.githubToken;
    environment.GITHUB_TOKEN = input.githubToken;
    environment.GH_HOST = "github.com";
  }
  if (input.githubConfigDir !== undefined) environment.GH_CONFIG_DIR = input.githubConfigDir;
  return environment;
}
