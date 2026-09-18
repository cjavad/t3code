import type { AuthCloudDevice, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useState } from "react";

import { assignServerCloudDevice, fetchServerCloudDevices } from "../../environments/primary/auth";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

const UNASSIGNED = "unassigned";

const shortThumbprint = (thumbprint: string) => `${thumbprint.slice(0, 8)}…`;

const lastSeenLabel = (device: AuthCloudDevice) => {
  const seen = new Date(DateTime.toEpochMillis(device.lastSeenAt));
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - seen.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "active now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} h ago`;
  return seen.toLocaleDateString();
};

/**
 * Who each T3 Connect device speaks for.
 *
 * Every client behind the relay proves the same linked cloud account, so the
 * account cannot tell one person from another. The DPoP key a device holds
 * can, so that is what gets claimed here. An unclaimed device still connects
 * and drives agents; it just authors nothing and cannot give a thread a Git
 * identity, which is what keeps one person's signing key out of another's
 * commits.
 */
export function CloudDeviceOwnership({
  environmentId,
  rowClassName,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly rowClassName: string;
}) {
  const [devices, setDevices] = useState<ReadonlyArray<AuthCloudDevice> | null>(null);
  const [busyThumbprint, setBusyThumbprint] = useState<string | null>(null);
  const users = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.gitIdentityUsers({ environmentId, input: {} }),
  );

  const load = useCallback(() => {
    void fetchServerCloudDevices().then(setDevices, () => setDevices([]));
  }, []);

  useEffect(load, [load]);

  const assign = async (device: AuthCloudDevice, userId: string | null) => {
    setBusyThumbprint(device.proofKeyThumbprint);
    try {
      await assignServerCloudDevice({ proofKeyThumbprint: device.proofKeyThumbprint, userId });
      load();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not change who this device acts as",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyThumbprint(null);
    }
  };

  if (devices === null || devices.length === 0) return null;

  return (
    <>
      {devices.map((device) => (
        <div key={device.proofKeyThumbprint} className={rowClassName}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {device.label ?? `T3 Connect device ${shortThumbprint(device.proofKeyThumbprint)}`}
              </p>
              <p className="truncate text-xs text-muted-foreground/60">
                {device.userId === null
                  ? "Acts as nobody — cannot author messages or commit"
                  : "Commits and messages are attributed to this user"}
                {" · "}
                {lastSeenLabel(device)}
              </p>
            </div>
            <Select
              value={device.userId ?? UNASSIGNED}
              disabled={busyThumbprint === device.proofKeyThumbprint}
              onValueChange={(value) => {
                if (value === null) return;
                void assign(device, value === UNASSIGNED ? null : String(value));
              }}
            >
              <SelectTrigger aria-label="User this device acts as" className="min-w-48" size="xs">
                <SelectValue>
                  {(users.data ?? []).find((user) => user.userId === device.userId)?.displayName ??
                    "Nobody"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNASSIGNED}>Nobody</SelectItem>
                {(users.data ?? []).map((user) => (
                  <SelectItem key={user.userId} value={user.userId}>
                    {user.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      ))}
    </>
  );
}
