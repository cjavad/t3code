# Fork operations

This repo is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
maintained at **cjavad/t3code**. It carries a small, additive set of patches on
top of upstream main, which includes orchestration V2 (PR #2829).

## Branches and remotes

| Ref                                  | Meaning                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `main`                               | Mirror of upstream main. Do not put fork-only features here.       |
| `origin/main`                        | Upstream base, including the merged V2 orchestrator.               |
| `feature/johan/device-ownership`     | Johan's T3 Connect device ownership feature.                       |
| `feature/johan/thread-notes`         | Johan's human-only notes and message author feature.               |
| `feature/johan/git-identity`         | Johan's persisted Git identity feature.                            |
| `feature/javad/git-identity-signing` | Per-session Git attribution and signing.                           |
| `fork/integration`                   | The tested combination of the feature branches and V2 adaptations. |
| `fork/deploy`                        | The exact commit used to build the server and desktop client.      |
| `fork/backup/*`                      | Upstream-side backups taken before each upstream rebase.           |

`origin` = pingdotgg (read-only to us); `fork` = cjavad (we push here).
The feature branches all start at the same upstream V2 base. `fork/integration`
combines them. Move `fork/deploy` only after the integration branch passes the
required checks. The server and desktop client must use the same deploy commit.

## Our patches

Keep them small and close to upstream. If upstream refactors something a patch
touches, **refactor the patch to match** — never duct-tape around it.

- **Identity & signing** — per-user Git identity / commit signing; `AuthUsers`.
- **Cloud device ownership** — T3 Connect devices mapped to a user
  (`CloudDevices`, migration 1002); `cloud-connect` never gets a user row.
- **Thread notes** — human-only messages (`role: "note"`) that never reach a
  provider, plus per-message author attribution.
- **Rebase adaptation** — the minimum needed to compile and pass tests after
  each rebase (e.g. renamed upstream APIs). Fold real fixes into the owning
  patch; use an adaptation commit only for pure upstream drift.

## Migrations

Upstream currently uses `1..67`. Fork migrations are `1001` (users), `1002`
(cloud devices), and `1003` (compressed storage). Released fork builds used
63/64/65; `reconcileForkMigrationGap` moves those ledger entries by their exact
names, preserves their timestamps, and applies missing upstream migrations in a
transaction. It also fills future upstream gaps below 1001 on subsequent updates.
Check the manifest on every update; never reuse an existing migration ID.

The upstream test that asserts the exact id list is named after whatever
upstream's newest released migration number currently is (it was
`054_OrchestrationV2.test.ts`, now `055_OrchestrationV2.test.ts` — it gets
renamed on each rebase). Adding or moving a fork migration means updating it
(contiguity list + the `executed` and ledger arrays) and
`apps/server/src/persistence/reconcileV2PreviewMigration.test.ts` (both
`runMigrations()` expectations).

## Reconciling upstream main

The V2 topic branch was squash-merged into upstream main as PR #2829. Use
`origin/main` for new integration work. Do not replay the old V2 topic history:
its changes are already included in upstream main.

Start a dedicated worktree at the latest upstream main and reapply only the
fork additions from the previous integration. Adapt them to upstream's current
services and contracts, retaining original author attribution. The previous
integration's upstream base identifies the fork-only diff; it is not the merge
base of main and the historical V2 branch.

```sh
git fetch --no-tags origin main:refs/remotes/origin/main
git fetch --no-tags fork 'refs/heads/fork/*:refs/remotes/fork/fork/*'
git worktree add -b reconcile/<date> /root/t3code-reconcile origin/main
```

The explicit main fetch also works in older checkouts whose default origin
fetch still names the now-deleted `t3code/codex-turn-mapping` branch.

Keep migrations 63 and 64 unchanged: running fork databases already have them.
Check the live migration ledger read-only, then verify startup and data reads
against a consistent SQLite backup of the running database. Never point the
candidate at live state. Run focused tests for the fork features, affected
package typechecks, and lint/format checks for changed files.

Build matching server and web assets from the verified commit. Keep a distinct
image tag for the candidate and record its commit ID. Move integration/deploy
refs and restart the production service only as an explicit deployment step.

## Deploy

Deployment clones `fork/deploy` from GitHub, so the commit must be pushed first.

**Before moving `fork/deploy`, check the live database ledger against the target's
migration manifest — a fresh-DB smoke test cannot catch this.** Upstream reuses
migration ids, and this instance's ledger was first written under V2-preview
numbering (ids 48-62 meant different migrations). The migrator keys on the _id_,
so a reused id is silently skipped and its schema change never runs (this broke a
deploy once: `no such column: auto_settle_disabled_at`). Compare the target's
`migrationEntries` against `effect_sql_migrations` in
`<base-dir>/userdata/statev2.sqlite`; for any id recorded under a preview name,
reconcile it on a scratch copy before preparing a deployment. The fork includes
a shape-based compatibility bridge for older projection columns; unexpected
ledger names still require investigation.

- `/root/t3-remote/update.sh --prepare` — build the image only.
- `/root/t3-remote/update.sh` — build if needed **and restart the service**.

**There is no dry-run.** Plain `update.sh` deploys (even on an already-prepared
image), so never run it just to check status. **Never deploy without explicit
approval.**

## Android preview APK (local build)

EAS cloud builds run under pingdotgg's Expo project, which we don't control, so
the APK is built locally.

Enable T3 Connect with a repo-root `.env` (gitignored, public values):

```sh
T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
T3CODE_CLERK_JWT_TEMPLATE=t3-relay
T3CODE_RELAY_URL=https://relay.t3.codes
T3CODE_MOBILE_UPDATES_ENABLED=0   # sideloaded: no EAS update channel
```

Without these the app falls back to `http://relay.invalid` and Connect is off.

Toolchain (once): JDK 17 + Android SDK at `/root/android-sdk` with
`platform-tools`, `platforms;android-36`, `build-tools;36.0.0`,
`ndk;27.1.12297006`, `cmake;3.22.1` — versions pinned by
`node_modules/react-native/gradle/libs.versions.toml`.

```sh
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
export ANDROID_HOME=/root/android-sdk ANDROID_SDK_ROOT=/root/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 APP_VARIANT=preview EXPO_NO_GIT_STATUS=1
cd apps/mobile
node_modules/.bin/expo prebuild --clean --platform android
cd android && ./gradlew assembleRelease
```

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
(package `com.t3tools.t3code.preview`, "T3 Code Preview", debug-signed, ~186 MB,
all four ABIs). First build ~15 min and ~15 GB; `apps/mobile/android/` and
`~/.gradle` are regenerable.

Gaps: no `google-services.json`, so push/FCM won't deliver, and Google sign-in
client IDs are unset. Neither affects T3 Connect.

## Toolchain

Everything on `jbox` runs through `/root/t3dev <cmd>` (cds into the deploy
worktree, puts Node 24 + `vp` on PATH).

Known jbox-only test failures (environment, not regressions): the root-permission
tests (`cli/theme`, `keybindings`, `provider/acp/AcpRegistrySupport`,
`terminal/Manager`) and `provider/acp/AcpSessionRuntime.processTree` (PATH
lookup).

## Pairing ownership

Pairing labels describe devices. Use the separate person identity (or CLI
`--subject javad`) to assign a person; blank remains unassigned. Authentication
subjects such as `one-time-token` never become user records. Cookie and WebSocket
verification use the persisted session subject so an ownership correction takes
effect consistently without changing the session credential or permissions.
