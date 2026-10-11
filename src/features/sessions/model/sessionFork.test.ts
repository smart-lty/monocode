import { describe, expect, it, vi } from "vitest";
import { checkForkAttachments, completedSessionBoundary, createForkChild, forkNativeTurns,
  forkVisibleHistory, FORK_VISIBLE_HISTORY_LIMIT, canExecuteSessionPlan } from "./sessionFork";
import { newSession, type Block } from "./session";
import { sentSessionReferences } from "./sessionReferences";
import { sanitizeSessionForPersist } from "../data/sessionStore";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { pendingHandoff } from "./handoff";

function source() {
  const session = newSession("codex", "/repo", "codex:gpt-6.1-sol", "full-access");
  session.providerSessionId = "native_parent";
  session.blocks = [
    { id: "u1", role: "user", text: "BEFORE_ALPHA", durationMs: 1,
      nativeContext: { harness: "codex", sessionId: "native_parent", turnId: "t1", source: "provider" },
      sessionReferences: [{ sessionId: "before_ref", cwd: "/before", harness: "pi", title: "Before" }] },
    { id: "tool1", role: "tool", text: "OLD_RESULT", tool: { callId: "call1", input: "OLD_CALL", status: "completed" } },
    { id: "plan1", role: "plan", text: "Unexecuted plan", plan: { status: "ready", approvedText: "Original approval" } },
    { id: "approval1", role: "approval", text: "Old grant", approval: { requestId: 7, decided: "allow" } },
    { id: "a1", role: "assistant", text: "first answer" },
    { id: "u2", role: "user", text: "AFTER_OMEGA", durationMs: 2,
      nativeContext: { harness: "codex", sessionId: "native_parent", turnId: "t2", source: "provider" },
      sessionReferences: [{ sessionId: "later_ref", cwd: "/later", harness: "pi", title: "Later" }] },
    { id: "a2", role: "assistant", text: "later answer" },
  ];
  return session;
}
const child = (strategy: "native" | "visible-history" | "handoff" = "native") => createForkChild({
  source: source(), endBlockId: "a1", childId: "child_app", requestId: "request1", strategy,
  ...(strategy === "native" ? { native: { providerSessionId: "native_child", nativeCutoff: "inclusive-turn" as const,
    nativeTurns: [{ harness: "codex" as const, sessionId: "native_child", turnId: "t1", source: "fork" as const }] } } : {}),
});

describe("completed-turn Fork", () => {
  it("includes the selected turn/tool pair and only sent references before it, with independent IDs and binding", () => {
    const fork = child();
    expect(fork.id).toBe("child_app"); expect(fork.providerSessionId).toBe("native_child");
    expect(fork.queuedMessages).toBeUndefined(); expect(fork.busy).toBeUndefined();
    expect(fork.blocks.some((block) => block.text.includes("AFTER_OMEGA"))).toBe(false);
    expect(fork.blocks.find((block) => block.role === "tool")?.tool).toMatchObject({ callId: "call1", input: "OLD_CALL", status: "completed" });
    expect(sentSessionReferences(fork.blocks).map((reference) => reference.sessionId)).toEqual(["before_ref"]);
    const ids = new Set(source().blocks.map((block) => block.id));
    expect(fork.blocks.every((block) => !ids.has(block.id))).toBe(true);
    const restored = sanitizeSessionForPersist(fork);
    expect(restored.blocks[0].nativeContext).toMatchObject({ sessionId: "native_child", source: "fork" });
    expect(restored.blocks[0].forkOrigin).toMatchObject({ sourceEndBlockId: "a1", strategy: "native", nativeCutoff: "inclusive-turn" });
  });
  it("preserves ready plan and historical approval facts while disabling execution; source stays unchanged", () => {
    const src = source(), before = JSON.stringify(src);
    const fork = createForkChild({ source: src, endBlockId: "a1", childId: "child", requestId: "req", strategy: "handoff" });
    const plan = fork.blocks.find((block) => block.role === "plan")!;
    expect(plan.plan).toEqual(src.blocks[2].plan); expect(plan.plan?.status).toBe("ready");
    expect(canExecuteSessionPlan(plan)).toBe(false);
    expect(canExecuteSessionPlan(src.blocks[2])).toBe(true);
    expect(fork.blocks.find((block) => block.role === "approval")?.approval?.decided).toBe("allow");
    expect(sanitizeSessionForPersist(fork).blocks.find((block) => block.role === "plan")?.inherited).toBe(true);
    expect(JSON.stringify(src)).toBe(before);
  });
  it("keeps historical plan/task/handoff states for display without restoring pending execution", () => {
    const src = source(); src.blocks[2].plan!.status = "building";
    src.blocks.unshift({ id: "old_handoff", role: "handoff", text: "Historical brief",
      handoff: { from: "pi", to: "codex", status: "ready", pending: true } });
    const fork = createForkChild({ source: src, endBlockId: "a1", childId: "child", requestId: "r", strategy: "native",
      native: { providerSessionId: "native_child", nativeCutoff: "inclusive-turn", nativeTurns: [
        { harness: "codex", sessionId: "native_child", turnId: "t1", source: "fork" }] } });
    const persisted = sanitizeSessionForPersist(fork);
    expect(persisted.blocks.find((block) => block.role === "plan")?.plan?.status).toBe("building");
    expect(persisted.blocks.find((block) => block.role === "handoff")?.handoff?.pending).toBe(true);
    expect(pendingHandoff(fork)).toBeNull(); expect(pendingHandoff(persisted as typeof fork)).toBeNull();
    expect(src.blocks.find((block) => block.role === "plan")?.plan?.status).toBe("building");
  });
  it("never matches new tool/approval/plan/task events against inherited history even if IDs are reused", () => {
    const fork = child();
    const oldPlan = fork.blocks.find((block) => block.role === "plan")!; oldPlan.plan!.key = "plan_key";
    fork.blocks.push({ id: "historical_tasks", role: "tasks", text: "Old tasks", inherited: true,
      taskList: { key: "task_key", items: [{ text: "Old task", status: "pending" }] } });
    const old = JSON.stringify(fork.blocks.filter((block) => block.inherited));
    let next = applyHarnessEvent(fork, { type: "approval.resolved", requestId: 7, decision: "deny" });
    next = applyHarnessEvent(next, { type: "tool.started", callId: "call1", title: "New tool" });
    next = applyHarnessEvent(next, { type: "approval.requested", requestId: 7, callId: "call1", title: "New approval" });
    next = applyHarnessEvent(next, { type: "plan", key: "plan_key", text: "New plan" });
    next = applyHarnessEvent(next, { type: "tasks.updated", key: "task_key", items: [{ text: "New task", status: "completed" }] });
    expect(JSON.stringify(next.blocks.filter((block) => block.inherited))).toBe(old);
    expect(next.blocks.some((block) => !block.inherited && block.plan?.key === "plan_key")).toBe(true);
    expect(next.blocks.some((block) => !block.inherited && block.taskList?.key === "task_key")).toBe(true);
  });
  it("allows only the latest completed boundary while source is running", () => {
    const src = source(); src.busy = true;
    src.blocks.push({ id: "u3", role: "user", text: "STREAMING_LATER" }, { id: "a3", role: "assistant", text: "live", streaming: true });
    expect(() => completedSessionBoundary(src, "a1")).toThrow("最近");
    expect(completedSessionBoundary(src, "a2").blocks.map((block) => block.id)).not.toContain("u3");
    expect(() => completedSessionBoundary(src, "a3")).toThrow("尚未完成");
  });
  it.each(["cancelled", "error"] as const)("rejects a %s boundary while keeping the earlier completed turn", (outcome) => {
    const src = source();
    src.blocks[5].turnOutcome = outcome;
    expect(() => completedSessionBoundary(src, "a2")).toThrow("尚未完成");
    src.busy = true;
    expect(completedSessionBoundary(src, "a1").user.id).toBe("u1");
  });
  it("rejects missing IDs, wrong binding, same-native-turn app boundaries, unknown end and unfinished tools", () => {
    const src = source();
    expect(() => completedSessionBoundary(src, "missing")).toThrow();
    delete src.blocks[0].nativeContext;
    expect(() => forkNativeTurns(src, completedSessionBoundary(src, "a1").blocks)).toThrow("缺少");
    src.blocks[0].nativeContext = { harness: "codex", sessionId: "wrong", turnId: "t1", source: "provider" };
    expect(() => forkNativeTurns(src, src.blocks)).toThrow("缺少");
    src.blocks[0].nativeContext.sessionId = "native_parent";
    src.blocks[5].nativeContext!.turnId = "t1";
    expect(() => forkNativeTurns(src, src.blocks)).toThrow("同一个");
    src.blocks[1].tool!.status = "in_progress";
    expect(() => completedSessionBoundary(src, "a1")).toThrow("未完成工具");
  });
  it("checks attachments before claiming native inheritance and keeps explicit reconstruction warnings", async () => {
    const src = source(); src.blocks[0].attachments = [{ id: "file", name: "missing.png", mimeType: "image/png", kind: "image", size: 10, path: "/missing.png" }];
    const available = vi.fn(async () => false);
    expect(await checkForkAttachments(completedSessionBoundary(src, "a1").blocks, available)).toEqual(["missing.png"]);
    const fork = createForkChild({ source: src, endBlockId: "a1", childId: "child", requestId: "req", strategy: "handoff", warnings: ["附件不可用"] });
    expect(fork.blocks[0].forkOrigin?.warnings).toEqual(["附件不可用"]);
    expect(fork.blocks[0].forkOrigin?.coverage?.complete).toBe(false);
  });
  it("persists provider turn mapping when Codex starts; queued drafts cannot become boundaries", () => {
    const src = source(); src.blocks.push({ id: "draft", role: "user", text: "unsent", draft: true });
    const next = applyHarnessEvent(src, { type: "turn.started", providerTurnId: "native_new" });
    expect(next.blocks[0].nativeContext?.turnId).toBe("t1");
    expect(() => completedSessionBoundary(src, "draft")).toThrow();
  });
});

describe("visible-history fidelity", () => {
  it("retains >8000 UTF-16 user/tool text exactly and excludes unique post-cutoff facts", () => {
    const src = source(); src.blocks[0].text = "  中文😀\r\n" + "U".repeat(10_000);
    src.blocks[1].tool!.input = "CALL".repeat(2500); src.blocks[1].tool!.detail = "RESULT".repeat(2000);
    const prefix = completedSessionBoundary(src, "a1").blocks;
    const value = forkVisibleHistory(prefix); const restored = JSON.parse(value.text);
    expect(restored[0].text).toBe(src.blocks[0].text);
    expect(restored[1].historicalTool.input).toBe(src.blocks[1].tool!.input);
    expect(restored[1].historicalTool.detail).toBe(src.blocks[1].tool!.detail);
    expect(value.text).not.toContain("AFTER_OMEGA"); expect(value.coverage.complete).toBe(true);
  });
  it("rejects a single long block or total budget overflow, never silently creating an excerpt child", () => {
    const src = source(); src.blocks[0].text = "x".repeat(FORK_VISIBLE_HISTORY_LIMIT);
    expect(() => createForkChild({ source: src, endBlockId: "a1", childId: "child", requestId: "r", strategy: "visible-history" })).toThrow("Handoff");
    src.blocks[0].text = "short"; src.blocks[1].tool!.detail = "x".repeat(FORK_VISIBLE_HISTORY_LIMIT);
    expect(() => forkVisibleHistory(completedSessionBoundary(src, "a1").blocks)).toThrow("Handoff");
    const blocks: Block[] = Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, role: "assistant", text: "x".repeat(7000) }));
    expect(() => forkVisibleHistory(blocks)).toThrow("超过");
    expect(child("visible-history").blocks[0].forkOrigin?.coverage?.complete).toBe(true);
  });
});
