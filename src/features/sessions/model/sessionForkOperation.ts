import type { Attachment, Session } from "./session";
import { newSession } from "./session";
import { checkForkAttachments, completedSessionBoundary, createForkChild, forkNativeTurns,
  forkVisibleHistory, type SessionForkRequest } from "./sessionFork";
import { UnboundForkError, type ForkSessionInput, type ForkSessionResult } from "../../../integrations/harness/core/types";

type ForkHost = {
  /** Re-reads application state and checks current source eligibility. */
  source: () => Session | undefined;
  available: (file: Attachment) => Promise<boolean>;
  fork: (harness: Session["harness"], input: ForkSessionInput) => Promise<ForkSessionResult>;
  save: (child: Session) => Promise<unknown>;
  remove: (childId: string, harness: Session["harness"]) => Promise<void>;
  /** Synchronous binding/opening only, after the last revalidation. */
  publish: (child: Session, source: Session) => void;
};

function signature(source: Session, endBlockId: string) {
  const { blocks } = completedSessionBoundary(source, endBlockId, true);
  return JSON.stringify({ binding: [source.id, source.harness, source.providerSessionId,
    source.providerAccountId, source.cwd, source.worktreeCwd, source.model, source.runtimeMode,
    source.modelSettings], blocks: blocks.map(({ btwThreads: _sideDiscussion, ...block }) => block) });
}

/** All async boundaries re-read the source; future turns never enter this child. */
export async function runSessionFork(request: Pick<SessionForkRequest,
  "sourceSessionId" | "sourceEndBlockId" | "requestId" | "strategy">, host: ForkHost): Promise<string> {
  const initial = host.source();
  if (!initial) throw new Error("Fork 来源已删除或不可用。");
  // Clone before awaiting: even an in-place edit must invalidate this snapshot.
  const snapshot = structuredClone(initial);
  const boundary = completedSessionBoundary(snapshot, request.sourceEndBlockId);
  const selectedSignature = signature(snapshot, request.sourceEndBlockId);
  const resolve = () => {
    const current = host.source();
    if (!current) throw new Error("Fork 等待期间来源已删除；未绑定 child。");
    if (signature(current, request.sourceEndBlockId) !== selectedSignature)
      throw new Error("Fork 等待期间截止点内内容或 binding 已变化；请重新选择分支点。");
    // Freeze exactly the revalidated prefix, including sent references only.
    return { ...current, blocks: completedSessionBoundary(current, request.sourceEndBlockId, true).blocks, busy: false };
  };
  const strategy = request.strategy ?? "native";
  if (strategy === "visible-history") forkVisibleHistory(boundary.blocks);
  const childId = crypto.randomUUID();
  let native: ForkSessionResult | undefined;
  let attemptedSave = false;
  try {
    const missing = await checkForkAttachments(boundary.blocks, host.available);
    let source = resolve();
    if (missing.length && strategy === "native")
      throw new Error(`Fork 附件不可用：${missing.join("、")}。请显式选择原文重建或 Handoff（附件仅说明）。`);
    if (strategy === "native") {
      native = await host.fork(source.harness, { sessionId: childId,
        sourceProviderSessionId: source.providerSessionId!, nativeTurns: forkNativeTurns(source, source.blocks),
        cwd: source.worktreeCwd ?? source.cwd, model: source.model, runtimeMode: source.runtimeMode,
        providerAccountId: source.providerAccountId });
      source = resolve();
    }
    const child = createForkChild({ source, endBlockId: request.sourceEndBlockId,
      requestId: request.requestId, childId, strategy, native,
      warnings: missing.map((name) => `附件不可用，仅保留历史说明：${name}`) });
    attemptedSave = true;
    await host.save(child);
    source = resolve();
    host.publish(child, source);
    return child.id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cleanupFailures: string[] = [];
    if (attemptedSave) await host.remove(childId, snapshot.harness).catch((failure) => cleanupFailures.push(`应用 child 清理失败：${String(failure)}`));
    let recoveryId = error instanceof UnboundForkError ? error.providerSessionId : undefined;
    if (native) {
      try {
        if (!native.discard) throw new Error("provider 未提供未绑定 child 清理接口");
        await native.discard();
      } catch (failure) {
        recoveryId = native.providerSessionId;
        cleanupFailures.push(`native child 清理失败：${String(failure)}`);
      }
    }
    if (recoveryId) {
      const recovery = newSession(snapshot.harness, snapshot.cwd, snapshot.model, "supervised");
      recovery.title = `Fork 未绑定（需恢复）· ${snapshot.title}`;
      const details = `${reason}\n${cleanupFailures.join("\n")}\n未绑定 native child：${recoveryId}。此记录没有 native binding；请由用户显式恢复或清理。`;
      recovery.blocks = [{ id: crypto.randomUUID(), role: "user", text: details, internal: true,
        forkOrigin: { sourceSessionId: snapshot.id, sourceUserBlockId: boundary.user.id,
          sourceEndBlockId: request.sourceEndBlockId, sourceProviderSessionId: snapshot.providerSessionId,
          strategy, cutoff: "completed-turn-inclusive", requestId: request.requestId, createdAt: Date.now(),
          blocks: [], warnings: [reason, ...cleanupFailures], recovery: { unboundNativeSessionId: recoveryId, reason: details } } },
      { id: crypto.randomUUID(), role: "system", text: details, notice: "error" }];
      try { await host.save(recovery); }
      catch (failure) { cleanupFailures.push(`恢复记录保存失败：${String(failure)}`); }
      throw new Error(`${details}${cleanupFailures.length ? `\n${cleanupFailures.join("\n")}` : ""}`);
    }
    if (cleanupFailures.length) throw new Error(`${reason}\n${cleanupFailures.join("\n")}`);
    throw error;
  }
}
