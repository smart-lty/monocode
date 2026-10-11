import type { OrchestrationRun, TaskStatus } from "./orchestration";
import { sessionNeedsInput, type HarnessId, type Session } from "../../sessions/model/session";

/** Small history projection; never includes prompts, results or credentials. */
export type OrchestrationSummary = {
  status: OrchestrationRun["status"];
  live?: boolean;
  tasks: {
    sessionId: string;
    title: string;
    harness: HarnessId;
    model: string;
    status: TaskStatus;
    accepted?: boolean;
    workspacePolicy?: "shared" | "isolated-child" | "isolated-top-level";
    needsInput?: boolean;
  }[];
};

export function summarizeOrchestration(
  run: OrchestrationRun,
  sessions: readonly Session[],
): OrchestrationSummary {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return {
    status: run.status,
    live: true,
    tasks: run.tasks.map(({ sessionId, title, harness, model, status, accepted, workspacePolicy }) => ({
      sessionId,
      title,
      harness,
      model,
      status,
      accepted,
      workspacePolicy,
      needsInput:
        !!byId.get(sessionId) && sessionNeedsInput(byId.get(sessionId)!),
    })),
  };
}

export function orchestrationTaskLabel(
  task: OrchestrationSummary["tasks"][number],
  summary: OrchestrationSummary,
): string {
  if (task.needsInput) return "Needs input";
  if (task.status === "completed") {
    if (task.accepted === undefined && !summary.live) return "Done";
    const shared = task.workspacePolicy === "shared";
    if (task.accepted) return shared ? "Reviewed" : "Integrated";
    if (summary.status === "stopped" || summary.status === "finished")
      return shared ? "Not reviewed" : "Not integrated";
    return "Awaiting review";
  }
  if (
    !summary.live &&
    ["running", "cancelling", "queued"].includes(task.status)
  )
    return "Saved";
  if (summary.status === "paused" && task.status === "queued") return "Paused";
  return {
    queued: "Queued",
    running: "Working",
    cancelling: "Stopping",
    completed: "Done",
    failed: "Failed",
    blocked: "Needs review",
    interrupted: "Interrupted",
    cancelled: "Cancelled",
  }[task.status];
}
