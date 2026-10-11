import { useEffect } from "react";
import type { Session } from "../../features/sessions/model/session";
import { orchestrator } from "../../features/orchestration/model/orchestration";

/** Restore loaded conversations even when none of their transcript is mounted. */
export function useOrchestrationRestore(
  sessions: readonly Session[],
  remoteProjectFor: (cwd: string) => unknown,
) {
  useEffect(() => {
    const leads = new Set(
      sessions
        .filter((session) =>
          !remoteProjectFor(session.cwd) && !session.inboxAsk && !session.worktreeRemoved,
        )
        .map((session) => session.orchestrationLeadId ?? session.id),
    );
    for (const id of leads) void orchestrator.hydrate(id).catch(console.error);
  }, [sessions, remoteProjectFor]);
}
