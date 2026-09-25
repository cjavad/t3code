import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AlertTriangleIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Which user this thread's agents commit as.
 *
 * The thread claims an identity from its first user message and keeps it, so a
 * colleague continuing someone else's thread does not silently take over its
 * commits. Reassigning ends the current provider session: a running agent
 * process keeps the environment it was started with, and pretending otherwise
 * would show an identity the next commit would not use.
 */
export function ThreadGitIdentityControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  const users = useEnvironmentQuery(
    sourceControlEnvironment.gitIdentityUsers({ environmentId: props.environmentId, input: {} }),
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const identity = shell?.source.gitIdentity ?? null;
  const candidates = users.data ?? [];
  const assigned =
    identity === null
      ? null
      : (candidates.find((candidate) => candidate.userId === identity.userId) ?? null);
  // An id with no matching account means the user was removed; say so rather
  // than rendering a raw `user:…` string as if it were a person.
  const label =
    identity === null
      ? "Unassigned"
      : (assigned?.displayName ?? `Unknown user (${identity.userId})`);
  const warning =
    identity === null
      ? "Agents cannot commit until this thread has an identity."
      : assigned === null
        ? "The assigned user no longer exists. Agents cannot commit."
        : !assigned.identityConfigured
          ? `${assigned.displayName} has not set up a Git identity yet, so agents cannot commit.`
          : null;

  const assign = async (userId: string | null) => {
    if (busy || userId === (identity?.userId ?? null)) return;
    setBusy(true);
    const result = await updateThreadMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, gitIdentityUserId: userId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change the thread's Git identity",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex flex-col" data-thread-git-identity>
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              variant="ghost"
              part="row"
              disabled={busy}
              aria-label={`Commits as ${label}`}
            />
          }
        >
          <UserRoundIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate text-left">Commits as {label}</span>
          <ChevronDownIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-60 max-w-(--available-width)">
          {candidates.length === 0 ? (
            <MenuItem disabled>No users available</MenuItem>
          ) : (
            candidates.map((candidate) => (
              <MenuItem key={candidate.userId} onClick={() => void assign(candidate.userId)}>
                {candidate.displayName}
                {candidate.identityConfigured ? "" : " — no Git identity"}
              </MenuItem>
            ))
          )}
          {identity === null ? null : <MenuItem onClick={() => void assign(null)}>Clear</MenuItem>}
        </MenuPopup>
      </Menu>
      {warning === null ? null : (
        <p className="flex items-start gap-1.5 px-2.5 pb-1 text-2xs leading-relaxed text-muted-foreground">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
          <span className="min-w-0">{warning}</span>
        </p>
      )}
    </div>
  );
}
