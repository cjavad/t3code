import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

export const AuthUserRecord = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  displayName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AuthUserRecord = typeof AuthUserRecord.Type;

export interface EnsureAuthUserInput {
  readonly subject: string;
  readonly now: string;
}

export class AuthUserRepository extends Context.Service<
  AuthUserRepository,
  {
    readonly ensureForSubject: (
      input: EnsureAuthUserInput,
    ) => Effect.Effect<AuthUserRecord, PersistenceSqlError>;
    readonly getBySubject: (
      subject: string,
    ) => Effect.Effect<AuthUserRecord | null, PersistenceSqlError>;
  }
>()("t3/persistence/AuthUsers/AuthUserRepository") {}

const userIdForSubject = (subject: string): string => `user:${subject}`;

const RawAuthUserRecord = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  displayName: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const decodeAuthUser = Schema.decodeUnknownEffect(AuthUserRecord);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readBySubjectRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ subject: Schema.String }),
    Result: RawAuthUserRecord,
    execute: ({ subject: requestedSubject }) => sql`
      SELECT id, subject, display_name AS "displayName", created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM auth_users
      WHERE subject = ${requestedSubject}
    `,
  });

  const readBySubject = (subject: string) =>
    readBySubjectRow({ subject }).pipe(
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(null),
          onSome: (row) => decodeAuthUser(row),
        }),
      ),
      Effect.mapError(toPersistenceSqlError("AuthUserRepository.getBySubject:query")),
    );

  const ensureForSubject: AuthUserRepository["Service"]["ensureForSubject"] = (input) =>
    sql`
      INSERT INTO auth_users (id, subject, display_name, created_at, updated_at)
      VALUES (${userIdForSubject(input.subject)}, ${input.subject}, ${input.subject}, ${input.now}, ${input.now})
      ON CONFLICT(subject) DO NOTHING
    `.pipe(
      Effect.mapError(toPersistenceSqlError("AuthUserRepository.ensureForSubject:insert")),
      Effect.andThen(readBySubject(input.subject)),
      Effect.flatMap((user) =>
        user === null
          ? Effect.fail(
              new PersistenceSqlError({
                operation: "AuthUserRepository.ensureForSubject:readback",
                detail: "The auth user row was not created.",
              }),
            )
          : Effect.succeed(user),
      ),
    );

  const getBySubject: AuthUserRepository["Service"]["getBySubject"] = readBySubject;

  return AuthUserRepository.of({ ensureForSubject, getBySubject });
});

export const layer = Layer.effect(AuthUserRepository, make);
