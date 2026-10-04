import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

/**
 * Devices that reach this environment through T3 Connect.
 *
 * Every client behind the relay authenticates against the one cloud account
 * the environment is linked to, so the cloud account cannot say *who* is
 * typing. The DPoP proof key each device holds can: it is per-device and
 * durable, so it is what a person is mapped to here.
 */
export const CloudDeviceRecord = Schema.Struct({
  proofKeyThumbprint: Schema.String,
  /** Local auth subject the device acts as; null until somebody assigns it. */
  subject: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.DateTimeUtcFromString,
  lastSeenAt: Schema.DateTimeUtcFromString,
  assignedBySubject: Schema.NullOr(Schema.String),
  assignedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CloudDeviceRecord = typeof CloudDeviceRecord.Type;

const RawCloudDeviceRecord = Schema.Struct({
  proofKeyThumbprint: Schema.String,
  subject: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
  assignedBySubject: Schema.NullOr(Schema.String),
  assignedAt: Schema.NullOr(Schema.String),
});

export interface RecordCloudDeviceSeenInput {
  readonly proofKeyThumbprint: string;
  readonly label?: string | undefined;
  readonly now: string;
}

export interface AssignCloudDeviceInput {
  readonly proofKeyThumbprint: string;
  /** Null unassigns the device, which stops it acting for anyone. */
  readonly subject: string | null;
  readonly assignedBySubject: string;
  readonly now: string;
}

export class CloudDeviceRepository extends Context.Service<
  CloudDeviceRepository,
  {
    readonly recordSeen: (
      input: RecordCloudDeviceSeenInput,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly subjectFor: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<string | null, PersistenceSqlError>;
    readonly list: () => Effect.Effect<ReadonlyArray<CloudDeviceRecord>, PersistenceSqlError>;
    readonly assign: (input: AssignCloudDeviceInput) => Effect.Effect<boolean, PersistenceSqlError>;
  }
>()("t3/persistence/CloudDevices/CloudDeviceRepository") {}

const decodeCloudDevice = Schema.decodeUnknownEffect(CloudDeviceRecord);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ proofKeyThumbprint: Schema.String }),
    Result: RawCloudDeviceRecord,
    execute: ({ proofKeyThumbprint }) => sql`
      SELECT
        proof_key_thumbprint AS "proofKeyThumbprint",
        subject,
        label,
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        assigned_by_subject AS "assignedBySubject",
        assigned_at AS "assignedAt"
      FROM auth_cloud_devices
      WHERE proof_key_thumbprint = ${proofKeyThumbprint}
    `,
  });

  const readAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RawCloudDeviceRecord,
    execute: () => sql`
      SELECT
        proof_key_thumbprint AS "proofKeyThumbprint",
        subject,
        label,
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        assigned_by_subject AS "assignedBySubject",
        assigned_at AS "assignedAt"
      FROM auth_cloud_devices
      ORDER BY last_seen_at DESC
    `,
  });

  const recordSeen: CloudDeviceRepository["Service"]["recordSeen"] = (input) =>
    sql`
      INSERT INTO auth_cloud_devices (
        proof_key_thumbprint, subject, label, first_seen_at, last_seen_at
      )
      VALUES (${input.proofKeyThumbprint}, NULL, ${input.label ?? null}, ${input.now}, ${input.now})
      ON CONFLICT(proof_key_thumbprint) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        label = COALESCE(auth_cloud_devices.label, excluded.label)
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("CloudDeviceRepository.recordSeen:upsert")),
    );

  const subjectFor: CloudDeviceRepository["Service"]["subjectFor"] = (proofKeyThumbprint) =>
    readRow({ proofKeyThumbprint }).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value.subject : null)),
      Effect.mapError(toPersistenceSqlError("CloudDeviceRepository.subjectFor:query")),
    );

  const list: CloudDeviceRepository["Service"]["list"] = () =>
    readAllRows(undefined).pipe(
      Effect.flatMap(Effect.forEach((row) => decodeCloudDevice(row))),
      Effect.mapError(toPersistenceSqlError("CloudDeviceRepository.list:query")),
    );

  const assign: CloudDeviceRepository["Service"]["assign"] = (input) =>
    Effect.gen(function* () {
      // A device has to have connected at least once before it can be given to
      // someone; assigning an invented thumbprint would otherwise look like it
      // worked and quietly do nothing.
      const existing = yield* readRow({ proofKeyThumbprint: input.proofKeyThumbprint }).pipe(
        Effect.mapError(toPersistenceSqlError("CloudDeviceRepository.assign:read")),
      );
      if (Option.isNone(existing)) return false;
      yield* sql`
        UPDATE auth_cloud_devices
        SET subject = ${input.subject},
            assigned_by_subject = ${input.assignedBySubject},
            assigned_at = ${input.now}
        WHERE proof_key_thumbprint = ${input.proofKeyThumbprint}
      `.pipe(Effect.mapError(toPersistenceSqlError("CloudDeviceRepository.assign:update")));
      return true;
    });

  return CloudDeviceRepository.of({ recordSeen, subjectFor, list, assign });
});

export const layer = Layer.effect(CloudDeviceRepository, make);
