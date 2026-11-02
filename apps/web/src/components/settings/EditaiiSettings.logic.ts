/**
 * What the Editaii settings page tells the person, from the panel the server sends: what a
 * disconnect would end, why new conversations cannot start, and what is under way.
 */
import type {
  EditaiiActivity,
  EditaiiConfiguration,
  EditaiiConnectionState,
  EditaiiDisconnectInput,
} from "@t3tools/contracts";

export type EditaiiTarget = typeof EditaiiDisconnectInput.Type.target;
type Job = Extract<EditaiiActivity, { readonly type: "available" }>["jobs"][number];
type Blocked = Extract<
  EditaiiActivity,
  { readonly type: "available" }
>["blockedConversations"][number];

/** What a disconnect ends: the connected link as shown, or the pairing attempt; null if neither. */
export function shownTarget(state: EditaiiConnectionState): EditaiiTarget | null {
  if (state.origin !== null && state.machine !== null)
    return {
      type: "link",
      origin: state.origin,
      machineId: state.machine.id,
      environmentId: state.machine.ambiente_t3,
    };
  return state.attempt === null ? null : { type: "attempt", attempt: state.attempt };
}

export function sameTarget(a: EditaiiTarget, b: EditaiiTarget): boolean {
  if (a.type === "attempt") return b.type === "attempt" && a.attempt === b.attempt;
  return (
    b.type === "link" &&
    a.origin === b.origin &&
    a.machineId === b.machineId &&
    a.environmentId === b.environmentId
  );
}

/** Why new Editaii conversations cannot start on this computer, or null when they can. */
export function configurationProblem(configuration: EditaiiConfiguration): string | null {
  if (configuration.type === "ready") return null;
  if (configuration.type === "unavailable")
    return "Could not read this computer's T3 settings or projects, so new Editaii conversations cannot start.";
  switch (configuration.reason) {
    case "no_project":
      return "Choose a project so new Editaii conversations can start on this computer.";
    case "project_missing":
      return "The chosen project no longer exists on this computer. Choose another.";
    case "no_model":
      return `Set a default model for "${configuration.projectTitle}" in T3.`;
    case "provider_disabled":
      return `The provider of the default model for "${configuration.projectTitle}" is disabled in T3.`;
  }
}

const JOB_STATE: Record<Job["state"], string> = {
  delivered: "Received, waiting for Editaii's confirmation",
  running: "Running",
  waiting_for_person: "Waiting for an answer in Editaii",
  action_in_t3: "Needs action in T3",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** A job as the person reads it: its state, then what it still owes Editaii. */
export function describeJob(job: Job): { state: string; owed: ReadonlyArray<string> } {
  const owed: Array<string> = [];
  if (job.receiptPending) owed.push("Receipt not yet delivered to Editaii");
  if (job.pendingEvents > 0)
    owed.push(
      job.pendingEvents === 1
        ? "1 update not yet returned to Editaii"
        : `${job.pendingEvents} updates not yet returned to Editaii`,
    );
  if (job.held) owed.push("Returns are paused: Editaii refused an update");
  return { state: JOB_STATE[job.state], owed };
}

export const BLOCKED_REASON: Record<Blocked["reason"], string> = {
  conflict: "Blocked: Editaii and this computer disagree about this conversation",
  thread_lost: "Blocked: its T3 thread needs checking",
};
