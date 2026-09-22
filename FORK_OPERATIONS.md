# Fork operations

This repo is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
maintained at **cjavad/t3code**. It carries a small, additive set of patches on
top of upstream's V2 branch — it is not meant to diverge.

## Branches and remotes

| Ref                                | Meaning                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `origin/t3code/codex-turn-mapping` | Upstream (pingdotgg) V2 branch. The base for everything here.             |
| `fork/identity-and-signing`        | **Deploy branch.** Our patches on top of upstream. `update.sh` builds it. |
| `fork/backup/codex-turn-mapping-*` | Upstream-side backups taken before each upstream rebase.                  |

`origin` = pingdotgg (read-only to us); `fork` = cjavad (we push here).
`fork/identity-and-signing` is based on the upstream V2 branch, **not** on
`main`.

## Our patches

Keep them small and close to upstream. If upstream refactors something a patch
touches, **refactor the patch to match** — never duct-tape around it.

- **Identity & signing** — per-user Git identity / commit signing; `AuthUsers`.
- **Cloud device ownership** — T3 Connect devices mapped to a user
  (`CloudDevices`, migration 064); `cloud-connect` never gets a user row.
- **Thread notes** — human-only messages (`role: "note"`) that never reach a
  provider, plus per-message author attribution.
- **Rebase adaptation** — the minimum needed to compile and pass tests after
  each rebase (e.g. renamed upstream APIs). Fold real fixes into the owning
  patch; use an adaptation commit only for pure upstream drift.

## Migrations

Upstream's released range is contiguous `1..54`. **Fork migrations start at 63**,
leaving `55-62` free for upstream V2 churn so a rebase never collides. Never edit
a released migration — add a new one.

Adding a fork migration means updating the two upstream tests that assert the
exact id list:

- `apps/server/src/persistence/Migrations/054_OrchestrationV2.test.ts`
  (contiguity list + the `executed` and ledger arrays)
- `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts`
  (both `runMigrations()` expectations)

## Rebasing onto upstream

```sh
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

git fetch origin --prune
git worktree add -b rebase/<date> /root/t3code-rebase fork/identity-and-signing
cd /root/t3code-rebase
# <base> = the commit immediately before our oldest patch (i.e. the last
# upstream / adaptation commit). Replay only our patches, not the old history:
git rebase --onto origin/t3code/codex-turn-mapping <base>
```

Resolve conflicts **in favour of upstream's shape**, then:

```sh
vp i
vp run -r --concurrency-limit 2 typecheck        # must be 0 errors
vp fmt && vp lint                                 # lint baseline: 0 errors
node_modules/.bin/vitest run --root apps/server <affected tests>
```

Validate migrations on a scratch DB by running the built image once with a fresh
`--base-dir` and confirming `Migrations ran successfully` with applied ids
ending `... 54, 63, 64` (plus HTTP 200).

When green: move the deploy branch (`git reset --hard <rebase-tip>` inside the
deploy worktree) and push it:

```sh
git push --force fork fork/identity-and-signing
```

## Deploy

Deployment clones this branch from GitHub, so the commit must be pushed first.

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
