import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const GitIdentityName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const GitIdentityEmail = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
/** GitHub usernames are 1-39 characters of letters, digits and hyphens. */
const GitHubUsername = TrimmedNonEmptyString.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9-]+$/u),
);

/** The public portion of the authenticated user's Git identity. */
export const GitIdentityProfile = Schema.Struct({
  displayName: GitIdentityName,
  email: GitIdentityEmail,
  /** Used to show the account's avatar and to attribute work to it. */
  githubUsername: GitHubUsername,
  signingKey: Schema.NullOr(Schema.String),
  githubTokenConfigured: Schema.Boolean,
});
export type GitIdentityProfile = typeof GitIdentityProfile.Type;

export const GitIdentityUpdateInput = Schema.Struct({
  displayName: GitIdentityName,
  email: GitIdentityEmail,
  githubUsername: GitHubUsername,
  /** A GitHub.com token used only for this user's PR API calls. */
  githubToken: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512)))),
});
export type GitIdentityUpdateInput = typeof GitIdentityUpdateInput.Type;

/**
 * A user a thread's Git identity can be assigned to. `identityConfigured` is
 * false for someone who has signed in but never set up a Git profile: assigning
 * a thread to them is allowed, but its agents will not be able to commit until
 * they do.
 */
export const GitIdentityUser = Schema.Struct({
  userId: TrimmedNonEmptyString,
  displayName: Schema.String,
  /** Null until the user has set up a Git identity. */
  githubUsername: Schema.NullOr(TrimmedNonEmptyString),
  identityConfigured: Schema.Boolean,
});
export type GitIdentityUser = typeof GitIdentityUser.Type;

export class GitIdentityError extends Schema.TaggedError<GitIdentityError>()("GitIdentityError", {
  reason: Schema.Literals([
    "not_configured",
    "invalid_email",
    "invalid_github_username",
    "key_generation_failed",
    "storage",
  ]),
  detail: Schema.String,
}) {}
