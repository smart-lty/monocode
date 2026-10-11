import type { Session } from "../../features/sessions/model/session";
import { finishSessionTurn } from "../../features/sessions/model/checkpoint";

/** The run may still be loading. Only explicit worker identity can recover a turn. */
export function finishStoppedWorkerCheckpoint(
  id: string,
  session?: Session,
  worker?: { cwd: string },
): Promise<void> {
  const cwd =
    worker?.cwd ??
    (session?.orchestrationLeadId && session.orchestrationLeadId !== id
      ? session.worktreeCwd ?? session.cwd
      : undefined);
  return cwd
    ? finishSessionTurn(id, cwd, { recover: true, required: true })
    : Promise.resolve();
}
