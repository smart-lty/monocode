import { beforeEach, expect, it, vi } from "vitest";
import { codexForkPrefix, forkCodexSession } from "./codexFork";
import type { ForkSessionInput } from "../../core/types";
import { UnboundForkError } from "../../core/types";

const state = vi.hoisted(() => ({ line: (_line: string) => {}, requests: [] as { method?: string; params?: Record<string, unknown> }[],
  source: [] as Record<string, unknown>[], copied: [] as Record<string, unknown>[], childId: "native_child",
  sourceGoal: null as unknown, childGoal: null as unknown, goalFailure: "", goalMissing: "", archiveFailure: false }));
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/codex" }), spawnChild: vi.fn(async () => undefined),
  killChild: vi.fn(async () => undefined), unwatchChild: vi.fn(),
  watchChild: (_id: string, line: (line: string) => void) => { state.line = line; },
  writeChild: async (_id: string, value: string) => {
    const request = JSON.parse(value); state.requests.push(request);
    if (!request.id) return;
    if ((request.method === "thread/goal/get" && state.goalFailure === request.params.threadId) ||
      (request.method === "thread/archive" && state.archiveFailure)) {
      state.line(JSON.stringify({ id: request.id, error: { message: "provider read/cleanup unavailable" } }));
      return;
    }
    const result = request.method === "thread/read" ? { thread: { id: request.params.threadId,
      turns: request.params.threadId === "native_parent" ? state.source : state.copied } }
      : request.method === "thread/fork" ? { thread: { id: state.childId, turns: state.copied } }
        : request.method === "thread/goal/get" ? state.goalMissing === request.params.threadId ? {} : {
          goal: request.params.threadId === "native_parent" ? state.sourceGoal : state.childGoal,
        } : {};
    state.line(JSON.stringify({ id: request.id, result }));
  },
}));
const input = (): ForkSessionInput => ({ sessionId: "child_app", sourceProviderSessionId: "native_parent", cwd: "/repo",
  model: "gpt-6.1-sol", runtimeMode: "full-access", nativeTurns: [{ harness: "codex", sessionId: "native_parent", turnId: "t1", source: "provider" }] });
beforeEach(() => {
  state.requests = []; state.childId = "native_child";
  state.sourceGoal = null; state.childGoal = null; state.goalFailure = ""; state.goalMissing = ""; state.archiveFailure = false;
  state.source = [{ id: "t1", status: "completed", items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "BEFORE" }] },
    { id: "call", type: "commandExecution", status: "completed", command: "old command", aggregatedOutput: "old result" }] },
  { id: "t2", status: "completed", items: [{ id: "u2", type: "userMessage", content: [{ type: "text", text: "AFTER" }] }] }];
  state.copied = structuredClone(state.source.slice(0, 1));
});
it("uses inclusive lastTurnId on an independent transport and verifies native child content before returning", async () => {
  const before = JSON.stringify(state.source);
  const result = await forkCodexSession(input());
  expect(result).toMatchObject({ providerSessionId: "native_child", nativeCutoff: "inclusive-turn", nativeTurns: [{ turnId: "t1", sessionId: "native_child" }] });
  expect(state.requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({ threadId: "native_parent", lastTurnId: "t1", deferGoalContinuation: true });
  expect(state.requests.filter((request) => request.method === "thread/goal/get").map((request) => request.params?.threadId))
    .toEqual(["native_parent", "native_child"]);
  expect(state.requests.some((request) => ["thread/resume", "turn/start", "turn/interrupt", "thread/rollback"].includes(request.method ?? ""))).toBe(false);
  expect(JSON.stringify(state.source)).toBe(before);
});

it.each(["active", "paused", "complete"])("rejects a saved %s source goal without changing it or creating a native child", async (status) => {
  state.sourceGoal = { status, objective: "AFTER_CUTOFF_GOAL" };
  const before = JSON.stringify({ source: state.source, goal: state.sourceGoal });
  await expect(forkCodexSession(input())).rejects.toThrow("存在当前或已保存 native goal");
  expect(state.requests.some((request) => ["thread/fork", "thread/archive", "thread/resume", "thread/goal/set", "thread/goal/clear"].includes(request.method ?? ""))).toBe(false);
  expect(JSON.stringify({ source: state.source, goal: state.sourceGoal })).toBe(before);
});

it.each(["failure", "missing"])("refuses exact Fork when the source goal check is %s", async (kind) => {
  if (kind === "failure") state.goalFailure = "native_parent";
  else state.goalMissing = "native_parent";
  await expect(forkCodexSession(input())).rejects.toThrow("visible-history 或 Handoff");
  expect(state.requests.some((request) => request.method === "thread/fork")).toBe(false);
});

it.each(["goal", "failure", "missing"])("cleans only the unbound child when its post-fork goal check finds %s", async (kind) => {
  if (kind === "goal") state.childGoal = { status: "paused", objective: "GOAL_ADDED_WHILE_FORK_WAITED" };
  else if (kind === "failure") state.goalFailure = "native_child";
  else state.goalMissing = "native_child";
  const before = JSON.stringify(state.source);
  await expect(forkCodexSession(input())).rejects.toThrow("visible-history 或 Handoff");
  expect(state.requests.filter((request) => request.method === "thread/archive").map((request) => request.params?.threadId))
    .toEqual(["native_child"]);
  expect(state.requests.some((request) => ["thread/resume", "thread/goal/set", "thread/goal/clear"].includes(request.method ?? ""))).toBe(false);
  expect(JSON.stringify(state.source)).toBe(before);
});

it("keeps the goal rejection reason and unbound ID if child cleanup also fails", async () => {
  state.childGoal = { status: "active" }; state.archiveFailure = true;
  const failed = await forkCodexSession(input()).catch((error) => error);
  expect(failed).toBeInstanceOf(UnboundForkError);
  expect(failed.providerSessionId).toBe("native_child"); expect(failed.message).toContain("native goal");
  expect(failed.message).toContain("清理失败");
});
it("rejects provider implementations that inherit later facts, and archives only the invalid child", async () => {
  state.copied = structuredClone(state.source);
  await expect(forkCodexSession(input())).rejects.toThrow("did not match");
  expect(state.requests.find((request) => request.method === "thread/archive")?.params?.threadId).toBe("native_child");
  expect(state.requests.some((request) => request.method === "thread/archive" && request.params?.threadId === "native_parent")).toBe(false);
});
it("rejects compacted/missing points, pending native tools and incomplete mappings", () => {
  expect(() => codexForkPrefix(state.source, { ...input(), nativeTurns: [{ ...input().nativeTurns[0], turnId: "missing" }] })).toThrow("missing");
  (state.source[1].items as unknown[]).push({ type: "contextCompaction" });
  expect(() => codexForkPrefix(state.source, input())).toThrow("compacted");
  state.source.pop(); (state.source[0].items as { status?: string }[])[1].status = "inProgress";
  expect(() => codexForkPrefix(state.source, input())).toThrow("unfinished");
});
it("never binds or archives the parent when a provider incorrectly returns the source ID", async () => {
  state.childId = "native_parent";
  await expect(forkCodexSession(input())).rejects.toThrow("independent");
  expect(state.requests.some((request) => request.method === "thread/archive")).toBe(false);
});
it("can discard a verified child on a new cleanup transport without touching the parent", async () => {
  const before = JSON.stringify(state.source), fork = await forkCodexSession(input());
  await fork.discard!();
  expect(state.requests.filter((request) => request.method === "thread/archive").map((request) => request.params?.threadId)).toEqual(["native_child"]);
  expect(state.requests.some((request) => request.method === "thread/resume")).toBe(false);
  expect(JSON.stringify(state.source)).toBe(before);
});
