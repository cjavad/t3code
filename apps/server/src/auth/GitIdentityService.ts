import * as NodeCrypto from "node:crypto";

import {
  GitIdentityError,
  type GitIdentityProfile,
  type GitIdentityUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

interface StoredProfile extends GitIdentityProfile {}

export interface GitCommitIdentity {
  readonly displayName: string;
  readonly email: string;
  /** Path to an SSH private key readable only by the server process. */
  readonly signingKeyPath: string;
}

export class GitIdentityService extends Context.Service<
  GitIdentityService,
  {
    readonly get: (subject: string) => Effect.Effect<GitIdentityProfile | null, GitIdentityError>;
    readonly update: (
      subject: string,
      input: GitIdentityUpdateInput,
    ) => Effect.Effect<GitIdentityProfile, GitIdentityError>;
    readonly resolveCommitIdentity: (
      subject: string,
    ) => Effect.Effect<GitCommitIdentity, GitIdentityError>;
    readonly resolveGitHubToken: (
      subject: string,
    ) => Effect.Effect<Redacted.Redacted<string> | null, GitIdentityError>;
  }
>()("t3/auth/GitIdentityService") {}

const subjectKey = (subject: string): string =>
  NodeCrypto.createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 40);

const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const process = yield* VcsProcess.VcsProcess;

  const names = (subject: string) => {
    const key = subjectKey(subject);
    return {
      profile: `git-identity-profile-${key}`,
      privateKey: `git-identity-private-${key}`,
      privateKeyPath: path.join(config.secretsDir, `git-identity-private-${key}.bin`),
      githubToken: `git-identity-github-token-${key}`,
    };
  };

  const readProfile = (subject: string) =>
    Effect.gen(function* () {
      const stored = yield* secrets.get(names(subject).profile).pipe(
        Effect.mapError(
          () =>
            new GitIdentityError({
              reason: "storage",
              detail: "The Git identity profile could not be read.",
            }),
        ),
      );
      if (Option.isNone(stored)) return null;
      try {
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const parsed = JSON.parse(new TextDecoder().decode(stored.value)) as StoredProfile;
        if (
          typeof parsed.displayName !== "string" ||
          typeof parsed.email !== "string" ||
          typeof parsed.signingKey !== "string" ||
          typeof parsed.githubTokenConfigured !== "boolean"
        ) {
          return yield* new GitIdentityError({
            reason: "storage",
            detail: "The stored Git identity profile is invalid.",
          });
        }
        return parsed;
      } catch (cause) {
        return yield* new GitIdentityError({
          reason: "storage",
          detail: "The stored Git identity profile could not be decoded.",
        });
      }
    });

  const persistProfile = (subject: string, profile: GitIdentityProfile) =>
    secrets.set(names(subject).profile, new TextEncoder().encode(JSON.stringify(profile))).pipe(
      Effect.mapError(
        () =>
          new GitIdentityError({
            reason: "storage",
            detail: "The Git identity profile could not be saved.",
          }),
      ),
    );

  const generateKey = (subject: string, email: string) =>
    Effect.gen(function* () {
      const keyNames = names(subject);
      const temporaryBase = path.join(
        config.secretsDir,
        `git-identity-generate-${subjectKey(subject)}-${NodeCrypto.randomUUID()}`,
      );
      yield* process
        .run({
          operation: "GitIdentityService.generateKey",
          command: "ssh-keygen",
          args: ["-q", "-t", "ed25519", "-N", "", "-C", email, "-f", temporaryBase],
          cwd: config.secretsDir,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.mapError(
            () =>
              new GitIdentityError({
                reason: "key_generation_failed",
                detail: "ssh-keygen could not create a signing key on the server.",
              }),
          ),
        );
      const privateKey = yield* fileSystem.readFile(temporaryBase).pipe(
        Effect.mapError(
          () =>
            new GitIdentityError({
              reason: "key_generation_failed",
              detail: "The generated signing key could not be read.",
            }),
        ),
      );
      const publicKey = yield* fileSystem.readFileString(`${temporaryBase}.pub`).pipe(
        Effect.map((value) => value.trim()),
        Effect.mapError(
          () =>
            new GitIdentityError({
              reason: "key_generation_failed",
              detail: "The generated public signing key could not be read.",
            }),
        ),
      );
      yield* secrets.set(keyNames.privateKey, privateKey).pipe(
        Effect.mapError(
          () =>
            new GitIdentityError({
              reason: "storage",
              detail: "The signing key could not be stored securely.",
            }),
        ),
      );
      yield* fileSystem.remove(temporaryBase).pipe(Effect.ignore);
      yield* fileSystem.remove(`${temporaryBase}.pub`).pipe(Effect.ignore);
      return publicKey;
    });

  const get: GitIdentityService["Service"]["get"] = (subject) => readProfile(subject);

  const update: GitIdentityService["Service"]["update"] = Effect.fn("GitIdentityService.update")(
    function* (subject, input) {
      const displayName = input.displayName.trim();
      const email = input.email.trim();
      if (!isValidEmail(email)) {
        return yield* new GitIdentityError({
          reason: "invalid_email",
          detail: "Enter a valid Git email address.",
        });
      }
      const existing = yield* readProfile(subject);
      if (input.githubToken === null) {
        yield* secrets.remove(names(subject).githubToken).pipe(Effect.ignore);
      } else if (input.githubToken !== undefined) {
        yield* secrets
          .set(names(subject).githubToken, new TextEncoder().encode(input.githubToken))
          .pipe(
            Effect.mapError(
              () =>
                new GitIdentityError({
                  reason: "storage",
                  detail: "The GitHub token could not be stored securely.",
                }),
            ),
          );
      }
      const githubTokenConfigured =
        input.githubToken === null
          ? false
          : input.githubToken !== undefined
            ? true
            : Option.isSome(
                yield* secrets.get(names(subject).githubToken).pipe(
                  Effect.mapError(
                    () =>
                      new GitIdentityError({
                        reason: "storage",
                        detail: "The GitHub token could not be read.",
                      }),
                  ),
                ),
              );
      const signingKey = existing?.signingKey ?? (yield* generateKey(subject, email));
      const profile: GitIdentityProfile = {
        displayName,
        email,
        signingKey,
        githubTokenConfigured,
      };
      yield* persistProfile(subject, profile);
      return profile;
    },
  );

  const resolveCommitIdentity: GitIdentityService["Service"]["resolveCommitIdentity"] = Effect.fn(
    "GitIdentityService.resolveCommitIdentity",
  )(function* (subject) {
    const profile = yield* readProfile(subject);
    if (profile === null || profile.signingKey === null) {
      return yield* new GitIdentityError({
        reason: "not_configured",
        detail: "Configure your Git identity before creating a commit.",
      });
    }
    const privateKey = yield* secrets.get(names(subject).privateKey).pipe(
      Effect.mapError(
        () =>
          new GitIdentityError({
            reason: "storage",
            detail: "The private signing key could not be read.",
          }),
      ),
    );
    if (Option.isNone(privateKey)) {
      return yield* new GitIdentityError({
        reason: "storage",
        detail: "The private signing key is missing from the server.",
      });
    }
    return {
      displayName: profile.displayName,
      email: profile.email,
      signingKeyPath: names(subject).privateKeyPath,
    };
  });

  const resolveGitHubToken: GitIdentityService["Service"]["resolveGitHubToken"] = Effect.fn(
    "GitIdentityService.resolveGitHubToken",
  )(function* (subject) {
    const token = yield* secrets.get(names(subject).githubToken).pipe(
      Effect.mapError(
        () =>
          new GitIdentityError({
            reason: "storage",
            detail: "The GitHub token could not be read.",
          }),
      ),
    );
    return Option.isSome(token) ? Redacted.make(new TextDecoder().decode(token.value)) : null;
  });

  return GitIdentityService.of({ get, update, resolveCommitIdentity, resolveGitHubToken });
});

export const layer = Layer.effect(GitIdentityService, make);
