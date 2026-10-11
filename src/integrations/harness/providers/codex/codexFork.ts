import { nativeModelId } from "../../../../features/sessions/model/models";
import { killChild, resolveCodexBinary, spawnChild, unwatchChild, watchChild } from "../../core/child";
import { JsonRpcClient } from "../../core/jsonRpc";
import { UnboundForkError, type ForkSessionInput, type ForkSessionResult } from "../../core/types";
import { asRecord, buildThreadStartParams, stringField } from "./codexProtocol";

function turnsIn(value: unknown): Record<string, unknown>[] {
  const turns = asRecord(asRecord(value)?.thread)?.turns;
  if (!Array.isArray(turns)) throw new Error("Codex did not expose the complete native turn history; exact Fork is unavailable.");
  return turns.map((turn) => asRecord(turn) ?? {});
}

export function codexForkPrefix(source: Record<string, unknown>[], input: ForkSessionInput) {
  const lastTurnId = input.nativeTurns[input.nativeTurns.length - 1]?.turnId;
  const end = source.findIndex((turn) => turn.id === lastTurnId);
  if (!lastTurnId || end < 0) throw new Error("Codex Fork point is missing or was compacted; no full-history fallback was made.");
  if (source.some((turn) => Array.isArray(turn.items) && turn.items.some((item) =>
    /compaction/i.test(stringField(asRecord(item), "type") ?? ""))))
    throw new Error("Codex compacted history cannot be verified for exact Fork; use explicit visible-history reconstruction.");
  const prefix = source.slice(0, end + 1);
  if (prefix.length !== input.nativeTurns.length || prefix.some((turn, index) =>
    turn.id !== input.nativeTurns[index].turnId || turn.status !== "completed"))
    throw new Error("Codex application/native turn mapping is incomplete or the boundary is not completed.");
  for (const turn of prefix) {
    if (!Array.isArray(turn.items)) throw new Error("Codex turn items are unavailable.");
    for (const item of turn.items) {
      const record = asRecord(item);
      if (record?.status === "inProgress" || record?.status === "in_progress")
        throw new Error("Codex Fork contains an unfinished tool call.");
    }
  }
  return prefix;
}

/** Remove only identity fields; content and tool pairing still must match. */
export function nativeHistoryContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nativeHistoryContent);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).filter(([key]) =>
    !["id", "threadId", "sessionID", "messageID"].includes(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, nativeHistoryContent(child)]));
}

/** Goal state is outside the selected turn prefix; only an explicit null is safe. */
async function requireNoNativeGoal(rpc: JsonRpcClient, threadId: string, target: "source" | "child"): Promise<void> {
  const label = target === "source" ? "来源" : "child";
  const fallback = "精确 Fork 已拒绝；请显式选择 visible-history 或 Handoff。";
  let response: unknown;
  try {
    response = await rpc.request("thread/goal/get", { threadId }, 15_000);
  } catch (error) {
    throw new Error(`Codex ${label} native goal 无法只读核验。${fallback} ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(response);
  if (!record || !Object.prototype.hasOwnProperty.call(record, "goal"))
    throw new Error(`Codex ${label} native goal 响应缺失，无法证明截止点安全。${fallback}`);
  if (record.goal !== null)
    throw new Error(`Codex ${label} 存在当前或已保存 native goal，无法证明其属于所选截止点；不绑定 child。${fallback}`);
}

/** Dedicated server reads/forks only. Never resumes, rewinds or stops source. */
export async function forkCodexSession(input: ForkSessionInput): Promise<ForkSessionResult> {
  const childId = `${input.sessionId}-fork`;
  const { path } = await resolveCodexBinary();
  const rpc = new JsonRpcClient(childId, { onNotification: () => undefined,
    onRequest: (id) => { void rpc.respond(id, { decision: "decline" }); } },
  { includeJsonrpc: false, label: "codex-fork" });
  watchChild(childId, (line) => rpc.pushLine(line), () => rpc.close(new Error("Codex Fork server exited")));
  let createdId: string | undefined;
  let verified = false;
  let failureReason: string | undefined;
  try {
    await spawnChild(childId, path, ["app-server"], input.cwd,
      { provider: "codex", id: input.providerAccountId ?? "default" }, "codex");
    await rpc.request("initialize", { clientInfo: { name: "monocode-fork", version: "0.1.0" },
      capabilities: { experimentalApi: true } }, 60_000);
    await rpc.notify("initialized", undefined);
    const read = await rpc.request("thread/read", { threadId: input.sourceProviderSessionId, includeTurns: true });
    const prefix = codexForkPrefix(turnsIn(read), input);
    await requireNoNativeGoal(rpc, input.sourceProviderSessionId, "source");
    const opened = await rpc.request("thread/fork", {
      ...buildThreadStartParams({ cwd: input.cwd, model: nativeModelId(input.model), runtimeMode: input.runtimeMode }),
      threadId: input.sourceProviderSessionId, lastTurnId: input.nativeTurns[input.nativeTurns.length - 1].turnId,
      ephemeral: false, excludeTurns: false, deferGoalContinuation: true,
    }, 60_000);
    createdId = stringField(asRecord(asRecord(opened)?.thread), "id");
    if (!createdId || createdId === input.sourceProviderSessionId)
      throw new Error("Codex Fork did not return an independent child ID.");
    const childTurns = turnsIn(await rpc.request("thread/read", { threadId: createdId, includeTurns: true }));
    if (childTurns.length !== prefix.length || JSON.stringify(nativeHistoryContent(childTurns)) !==
      JSON.stringify(nativeHistoryContent(prefix)))
      throw new Error("Codex native child history did not match the inclusive cutoff; the child was not bound.");
    // Goal creation while the native fork was pending can be copied even
    // though the inclusive turn history still matches perfectly.
    await requireNoNativeGoal(rpc, createdId, "child");
    verified = true;
    return { providerSessionId: createdId, nativeCutoff: "inclusive-turn", nativeTurns: childTurns.map((turn) => ({
      harness: "codex", sessionId: createdId!, turnId: stringField(turn, "id"), source: "fork",
    })), discard: () => discardCodexFork(input, createdId!) };
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    let cleanupError: UnboundForkError | undefined;
    if (createdId && !verified && createdId !== input.sourceProviderSessionId) {
      try { await rpc.request("thread/archive", { threadId: createdId }); }
      catch (error) { cleanupError = new UnboundForkError(`${failureReason ?? "Codex Fork 验证失败"}\nCodex 未绑定 child 清理失败：${String(error)}`, createdId); }
    }
    rpc.close();
    unwatchChild(childId);
    await killChild(childId).catch(() => undefined);
    if (cleanupError) throw cleanupError;
  }
}

async function discardCodexFork(input: ForkSessionInput, nativeChildId: string): Promise<void> {
  if (nativeChildId === input.sourceProviderSessionId) throw new Error("Refusing to archive the Fork source.");
  const childId = `${input.sessionId}-fork-discard`;
  const { path } = await resolveCodexBinary();
  const rpc = new JsonRpcClient(childId, { onNotification: () => undefined,
    onRequest: (id) => { void rpc.respond(id, { decision: "decline" }); } },
  { includeJsonrpc: false, label: "codex-fork-discard" });
  watchChild(childId, (line) => rpc.pushLine(line), () => rpc.close(new Error("Codex Fork cleanup server exited")));
  try {
    await spawnChild(childId, path, ["app-server"], input.cwd,
      { provider: "codex", id: input.providerAccountId ?? "default" }, "codex");
    await rpc.request("initialize", { clientInfo: { name: "monocode-fork", version: "0.1.0" },
      capabilities: { experimentalApi: true } }, 60_000);
    await rpc.notify("initialized", undefined);
    await rpc.request("thread/archive", { threadId: nativeChildId });
  } finally {
    rpc.close(); unwatchChild(childId);
    await killChild(childId).catch(() => undefined);
  }
}
