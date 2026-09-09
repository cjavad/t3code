import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type {
  CodexGoal,
  CodexGoalSetInput,
  CodexGoalStatus,
  CodexGoalStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { WS_METHODS } from "@t3tools/contracts";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CancelQueuedRunInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type EditQueuedRunInput,
  type InterruptThreadTurnInput,
  type MarkThreadUnreadInput,
  type ForkThreadFromRunInput,
  type MergeThreadBackInput,
  type PromoteQueuedRunInput,
  type ReorderQueuedRunInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type DismissThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type ReorderActiveThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  type VisitThreadInput,
  archiveThread,
  cancelQueuedRun,
  createThread,
  deleteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  promoteQueuedRun,
  reorderQueuedRun,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  ThreadHistoryController,
  type ThreadHistoryLoadEarlierResult,
} from "./threadHistoryController.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
};

export type {
  ArchiveThreadInput,
  CancelQueuedRunInput,
  CreateThreadInput,
  DeleteThreadInput,
  EditQueuedRunInput,
  InterruptThreadTurnInput,
  MarkThreadUnreadInput,
  ForkThreadFromRunInput,
  MergeThreadBackInput,
  PromoteQueuedRunInput,
  ReorderQueuedRunInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  DismissThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  ReorderActiveThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  ThreadCommandInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
  VisitThreadInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const codexGoal = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:codex-goal",
    tag: WS_METHODS.subscribeCodexGoal,
    idleTtlMs: 0,
    transform: (events) =>
      events.pipe(
        Stream.retry(Schedule.spaced("2 seconds")),
        Stream.map(applyCodexGoalStreamEvent),
      ),
  });
  return {
    codexGoal,
    getCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:get",
      tag: WS_METHODS.codexGoalGet,
      scheduler,
      concurrency,
    }),
    setCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:set",
      tag: WS_METHODS.codexGoalSet,
      scheduler,
      concurrency,
    }),
    clearCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:clear",
      tag: WS_METHODS.codexGoalClear,
      scheduler,
      concurrency,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: ReorderActiveThreadInput) => reorderActiveThread(input),
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: (input: VisitThreadInput) => visitThread(input),
      scheduler,
      concurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: (input: MarkThreadUnreadInput) => markThreadUnread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: (input: DismissThreadUserInputInput) => dismissThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: (input: ForkThreadFromRunInput) => forkThreadFromRun(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: (input: MergeThreadBackInput) => mergeThreadBack(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    reorderQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-queued-run",
      execute: (input: ReorderQueuedRunInput) => reorderQueuedRun(input),
      scheduler,
      concurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: (input: PromoteQueuedRunInput) => promoteQueuedRun(input),
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: (input: CancelQueuedRunInput) => cancelQueuedRun(input),
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: (input: EditQueuedRunInput) => editQueuedRun(input),
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: (input: LoadEarlierThreadHistoryInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const controller = yield* Effect.serviceOption(ThreadHistoryController);
          if (Option.isNone(controller)) {
            return { _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult;
          }
          return yield* controller.value.loadEarlier(
            supervisor.target.environmentId,
            input.threadId,
          );
        }),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
}

export type CodexGoalCommand =
  | { readonly action: "status" }
  | { readonly action: "set"; readonly objective?: string; readonly status?: "active" | "paused" }
  | { readonly action: "clear" }
  | { readonly action: "invalid"; readonly message: string };

const GOAL_USAGE =
  "Usage: /goal [status | create <objective> | steer <objective> | pause | resume | clear | reset]";

export function formatCodexGoalUsage(goal: CodexGoal): string {
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget.toLocaleString()}`;
  return `${goal.tokensUsed.toLocaleString()} tokens${budget}, ${goal.timeUsedSeconds.toLocaleString()} seconds`;
}

export function formatCodexGoalDescription(goal: CodexGoal): string {
  return `${goal.objective} - ${formatCodexGoalUsage(goal)}`;
}

const CODEX_GOAL_STATUS_LABELS: Record<CodexGoalStatus, string> = {
  active: "active",
  paused: "paused",
  budgetLimited: "budget limited",
  usageLimited: "usage limited",
  complete: "complete",
  blocked: "blocked",
};

export function formatCodexGoalStatus(status: CodexGoalStatus): string {
  return CODEX_GOAL_STATUS_LABELS[status];
}

export function formatCodexGoalError(error: unknown): string {
  if (!(error instanceof Error)) return "Codex Goal operation failed.";
  const reason = error.cause instanceof Error ? error.cause.message.trim() : "";
  return reason.length === 0 ? error.message : `${error.message}: ${reason}`;
}

export function parseCodexGoalCommand(value: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(value.trim());
  if (match === null) return null;

  const argument = match[1]?.trim() ?? "";
  if (argument === "" || argument.toLowerCase() === "status") return { action: "status" };

  const [rawAction = "", ...rest] = argument.split(/\s+/);
  const action = rawAction.toLowerCase();
  const objective = rest.join(" ").trim();
  if (action === "create" || action === "steer") {
    if (objective === "") return { action: "invalid", message: GOAL_USAGE };
    return action === "create"
      ? { action: "set", objective, status: "active" }
      : { action: "set", objective };
  }
  if (action === "edit") {
    return objective === ""
      ? {
          action: "invalid",
          message: "T3 does not open Codex's Goal editor. Use /goal steer <objective>.",
        }
      : { action: "set", objective };
  }
  if (action === "pause" || action === "resume") {
    if (objective !== "") return { action: "invalid", message: GOAL_USAGE };
    return { action: "set", status: action === "pause" ? "paused" : "active" };
  }
  if (action === "clear" || action === "reset") {
    if (objective !== "") return { action: "invalid", message: GOAL_USAGE };
    return { action: "clear" };
  }
  if (action === "status") return { action: "invalid", message: GOAL_USAGE };

  return { action: "set", objective: argument, status: "active" };
}

export function toCodexGoalSetInput(
  threadId: CodexGoalSetInput["threadId"],
  command: Extract<CodexGoalCommand, { readonly action: "set" }>,
): CodexGoalSetInput {
  const { action: _action, ...input } = command;
  return { threadId, ...input };
}

export function applyCodexGoalStreamEvent(event: CodexGoalStreamEvent): CodexGoal | null {
  if (event.type === "snapshot" || event.type === "updated") return event.goal;
  return null;
}
