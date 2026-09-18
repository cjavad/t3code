import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per device that has connected through T3 Connect, keyed by the
  // DPoP proof key it holds. `subject` is null until somebody says who the
  // device belongs to; an unassigned device still connects, it just cannot
  // speak for a person.
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_cloud_devices (
      proof_key_thumbprint TEXT PRIMARY KEY,
      subject TEXT,
      label TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      assigned_by_subject TEXT,
      assigned_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_cloud_devices_subject ON auth_cloud_devices(subject)
  `;
});
