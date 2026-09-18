import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const GitIdentityName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const GitIdentityEmail = TrimmedNonEmptyString.check(Schema.isMaxLength(320));

/** The public portion of the authenticated user's Git identity. */
export const GitIdentityProfile = Schema.Struct({
  displayName: GitIdentityName,
  email: GitIdentityEmail,
  signingKey: Schema.NullOr(Schema.String),
  githubTokenConfigured: Schema.Boolean,
});
export type GitIdentityProfile = typeof GitIdentityProfile.Type;

export const GitIdentityUpdateInput = Schema.Struct({
  displayName: GitIdentityName,
  email: GitIdentityEmail,
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
  identityConfigured: Schema.Boolean,
});
export type GitIdentityUser = typeof GitIdentityUser.Type;

export class GitIdentityError extends Schema.TaggedError<GitIdentityError>()("GitIdentityError", {
  reason: Schema.Literals(["not_configured", "invalid_email", "key_generation_failed", "storage"]),
  detail: Schema.String,
}) {}
