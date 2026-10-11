import type { Attachment, Block, Session, SessionForkOrigin } from "./session";
import { newSession } from "./session";
import { groupTurns } from "./transcriptActivity";
import type { ForkSessionResult } from "../../../integrations/harness/core/types";
import { buildDeterministicHandoff, buildHandoffComposerCard } from "./handoff";

export const FORK_VISIBLE_HISTORY_LIMIT = 64_000;
/** Full visible text and tool input/result. This never uses Btw's excerpt budget. */
export function forkVisibleHistory(blocks: Block[]) {
  const visible = blocks.filter((block) => !block.draft && !block.internal);
  const text = JSON.stringify(visible.map((block) => ({
    sourceBlockId: block.id, role: block.role, text: block.text,
    ...(block.tool ? { historicalTool: block.tool } : {}),
    ...(block.attachments ? { attachments: block.attachments } : {}),
    ...(block.image ? { image: block.image } : {}),
    ...(block.plan ? { historicalPlan: block.plan } : {}),
    ...(block.taskList ? { historicalTasks: block.taskList } : {}),
    ...(block.approval ? { historicalApproval: block.approval } : {}),
    ...(block.agentRun ? { historicalAgentRun: block.agentRun } : {}),
    ...(block.handoff ? { historicalHandoff: block.handoff } : {}),
    ...(block.sessionReferences ? { sessionReferences: block.sessionReferences } : {}),
  })));
  if (text.length > FORK_VISIBLE_HISTORY_LIMIT)
    throw new Error(`截止点内可见原文为 ${text.length} 字符，超过 ${FORK_VISIBLE_HISTORY_LIMIT} 上限；未创建 child。请显式选择有损 Handoff。`);
  return { text, coverage: { visibleBlocks: visible.length, chars: text.length, complete: true,
    omitted: ["provider hidden state", "approval authority"] } };
}

/** Resolve against current blocks, never the stale array supplied by a menu. */
export function completedSessionBoundary(source: Session, endBlockId: string, revalidate = false) {
  const turns = groupTurns(source.blocks).filter((turn) =>
    turn.some((block) => block.role === "user" && !block.draft && !block.internal),
  );
  const complete = (turn: Block[]) => {
    const user = turn.find((block) => block.role === "user");
    return user?.durationMs != null && !user.turnOutcome && !turn.some((block) => block.streaming);
  };
  const turn = turns.find((candidate) => candidate[candidate.length - 1]?.id === endBlockId);
  if (!turn || !complete(turn)) throw new Error("请选择已完成轮次的末尾；该分支点不存在或尚未完成。");
  const completed = turns.filter(complete);
  // The latest-completed restriction applies when selecting a boundary. An
  // already selected, unchanged boundary remains fixed while future turns append.
  if (!revalidate && source.busy && completed[completed.length - 1] !== turn)
    throw new Error("父会话运行时只能从最近已完成轮次分叉。");
  const end = source.blocks.findIndex((block) => block.id === endBlockId);
  const blocks = source.blocks.slice(0, end + 1).filter((block) =>
    !block.draft && !block.internal && !block.orchestration &&
    !source.queuedMessages?.some((message) => message.blockId === block.id),
  );
  if (blocks.some((block) => block.streaming || (block.role === "tool" &&
    !["completed", "failed", "cancelled", "interrupted"].includes(block.tool?.status ?? ""))))
    throw new Error("截止点内有未完成工具；不能继承未配对或仍在运行的操作。");
  if (blocks.some((block) => block.role === "approval" && !block.approval?.decided))
    throw new Error("截止点内有未完成批准；请先完成该轮。");
  return { blocks, turn, user: turn.find((block) => block.role === "user")! };
}

export function forkNativeTurns(source: Session, blocks: Block[]) {
  if (!source.providerSessionId || !["codex", "opencode"].includes(source.harness))
    throw new Error("该会话没有可用的精确 native Fork；请选择明确标识的原文重建或 Handoff。");
  const users = blocks.filter((block) => block.role === "user");
  const turns = users.map((block) => {
    const context = block.nativeContext;
    if (!context || context.harness !== source.harness || context.sessionId !== source.providerSessionId ||
      (context.harness === "codex" ? !context.turnId : !context.userMessageId || !context.messageIds?.length))
      throw new Error("缺少当前 binding 的 native ID 映射；不能精确 Fork，请选择原文重建或 Handoff。");
    return context;
  });
  const ids = turns.map((turn) => turn.turnId ?? turn.userMessageId);
  if (new Set(ids).size !== ids.length)
    throw new Error("多个应用轮次属于同一个 native turn，无法精确分隔；请选择原文重建。");
  return turns;
}

export async function checkForkAttachments(blocks: Block[], available: (file: Attachment) => Promise<boolean>) {
  const missing: string[] = [];
  for (const block of blocks) {
    for (const file of block.attachments ?? []) {
      if (!(await available(file))) missing.push(file.name || file.id);
    }
    if (block.image?.path && !(await available({ id: block.id, name: block.image.name,
      path: block.image.path, size: block.image.size, mimeType: block.image.mimeType, kind: "image" })))
      missing.push(block.image.name || block.id);
  }
  return missing;
}

export function createForkChild(input: {
  source: Session; endBlockId: string; requestId: string; childId: string;
  strategy: SessionForkOrigin["strategy"]; native?: ForkSessionResult; warnings?: string[];
}): Session {
  const { source, strategy, native } = input;
  const boundary = completedSessionBoundary(source, input.endBlockId);
  const visible = strategy === "visible-history" ? forkVisibleHistory(boundary.blocks) : undefined;
  if (strategy === "native" && (!native || native.providerSessionId === source.providerSessionId))
    throw new Error("Fork 没有返回独立的 native child。");
  const pairs = boundary.blocks.map((block) => ({ sourceId: block.id, childId: crypto.randomUUID() }));
  let turnIndex = -1;
  const blocks: Block[] = boundary.blocks.map((block, index) => {
    if (block.role === "user") turnIndex++;
    const next = structuredClone(block);
    next.id = pairs[index].childId;
    delete next.btwThreads;
    delete next.appRequestId;
    delete next.monocode;
    delete next.orchestrationLeadId;
    delete next.forkOrigin;
    delete next.nativeContext;
    delete next.providerTurnId;
    if (next.intent === "orchestrate") delete next.intent;
    next.inherited = true;
    if (native && block.role === "user") {
      next.nativeContext = native.nativeTurns[turnIndex];
      next.providerTurnId = next.nativeContext?.turnId;
    }
    return next;
  });
  const origin: SessionForkOrigin = {
    sourceSessionId: source.id, sourceUserBlockId: boundary.user.id,
    sourceEndBlockId: input.endBlockId, sourceProviderSessionId: source.providerSessionId,
    sourceNativeId: boundary.user.nativeContext?.turnId ?? boundary.user.nativeContext?.userMessageId,
    strategy, cutoff: "completed-turn-inclusive", nativeCutoff: native?.nativeCutoff,
    requestId: input.requestId, createdAt: Date.now(), blocks: pairs,
    warnings: input.warnings ?? [],
    ...(visible ? { coverage: visible.coverage } : strategy === "handoff" ? {
      coverage: { visibleBlocks: boundary.blocks.length, chars: 0, complete: false, omitted: ["有损 Handoff 摘要，不是完整原文或 native 上下文"] },
    } : {}),
  };
  blocks.find((block) => block.role === "user")!.forkOrigin = origin;
  const child: Session = {
    ...newSession(source.harness, source.cwd, source.model, source.runtimeMode),
    id: input.childId, blocks, title: `Fork · ${source.title}`,
    modelSettings: { ...source.modelSettings }, providerAccountId: source.providerAccountId,
    worktreeCwd: source.worktreeCwd, branch: source.branch,
    ...(native ? { providerSessionId: native.providerSessionId } : {}),
  };
  if (strategy !== "native") {
    const sliced = { ...source, blocks: boundary.blocks };
    const brief = strategy === "handoff" ? buildDeterministicHandoff(sliced)
      : visible!.text;
    if (strategy === "handoff") origin.coverage!.chars = brief.length;
    child.handoffCard = buildHandoffComposerCard({ from: source.harness, to: source.harness,
      brief: `继承方式：${strategy}；截止 ${input.endBlockId}（包含该轮）。\n历史工具与批准不是新执行授权。\n${brief}`,
      userRequest: boundary.user.text, files: [] });
    // Keep the context durable if the child is closed before its first send.
    blocks.push({ id: crypto.randomUUID(), role: "handoff", text: child.handoffCard.brief,
      handoff: { from: source.harness, to: source.harness, status: "ready", pending: true } });
  }
  blocks.push({ id: crypto.randomUUID(), role: "system",
    text: `Fork：${strategy}，包含截止轮次。当前工作目录：${source.worktreeCwd ?? source.cwd}。会话分叉不会回滚文件，也不提供 workspace 隔离。${origin.warnings.length ? `\n${origin.warnings.join("\n")}` : ""}` });
  return child;
}

export function canExecuteSessionPlan(block: Block | undefined): boolean {
  return !!block && !block.inherited && block.role === "plan" && block.plan?.status === "ready";
}

export const SESSION_FORK_EVENT = "monocode:session-fork";
export type SessionForkRequest = { sourceSessionId: string; sourceEndBlockId: string;
  strategy?: SessionForkOrigin["strategy"]; requestId: string;
  resolve: (childId: string) => void; reject: (error: Error) => void };
/** UI calls this from a completed-turn menu; success opens an independent pane. */
export function requestSessionFork(sourceSessionId: string, sourceEndBlockId: string,
  strategy: SessionForkOrigin["strategy"] = "native", requestId = crypto.randomUUID()): Promise<string> {
  return new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent<SessionForkRequest>(
    SESSION_FORK_EVENT, { detail: { sourceSessionId, sourceEndBlockId, strategy, requestId, resolve, reject } })));
}
