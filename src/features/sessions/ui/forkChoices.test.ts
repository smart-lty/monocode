import { describe, expect, it } from "vitest";
import { forkInheritance, forkMenu, turnLabel } from "./forkChoices";
import { createForkChild, FORK_VISIBLE_HISTORY_LIMIT } from "../model/sessionFork";
import { newSession, type Block } from "../model/session";

function source() {
  const session = newSession("codex", "/repo", "gpt-5", "supervised");
  session.providerSessionId = "native_parent";
  session.blocks = [
    { id: "u1", role: "user", text: "First question\nwith detail", durationMs: 1,
      nativeContext: { harness: "codex", sessionId: "native_parent", turnId: "t1", source: "provider" } },
    { id: "tool1", role: "tool", text: "ls", tool: { callId: "c1", status: "completed" } },
    { id: "a1", role: "assistant", text: "first answer" },
    { id: "u2", role: "user", text: "Second question", durationMs: 1,
      nativeContext: { harness: "codex", sessionId: "native_parent", turnId: "t2", source: "provider" } },
    { id: "a2", role: "assistant", text: "second answer" },
  ];
  return session;
}

const strategies = (menu: ReturnType<typeof forkMenu>) =>
  Object.fromEntries(menu.choices.map((choice) => [choice.strategy, choice.unavailable]));

describe("fork choices", () => {
  it("ends at the turn's last block in the session's own grouping", () => {
    const menu = forkMenu(source(), "u1");
    expect(menu.endBlockId).toBe("a1");
    expect(menu.blocked).toBeUndefined();
    expect(strategies(menu)).toEqual({ native: undefined, "visible-history": undefined, handoff: undefined });
  });

  it("numbers turns readably from the question's first line", () => {
    expect(turnLabel(source().blocks, "a1")?.label).toBe("Turn 1 · First question");
    expect(turnLabel(source().blocks, "u2")?.label).toBe("Turn 2 · Second question");
    expect(turnLabel(source().blocks, "missing")).toBeUndefined();
  });

  it("blocks every way on an older turn while the session runs, with the fork's own reason", () => {
    const running = source();
    running.busy = true;
    running.blocks.push({ id: "u3", role: "user", text: "Third", startedAt: 1 });
    const menu = forkMenu(running, "u1");
    expect(menu.blocked).toBe("父会话运行时只能从最近已完成轮次分叉。");
    expect(forkMenu(running, "u2").blocked).toBeUndefined();
    expect(forkMenu(running, "u3").blocked).toMatch(/尚未完成/);
  });

  it("gives the exact reason native is unavailable and leaves the other ways open", () => {
    const claude = { ...source(), harness: "claude" as const };
    expect(strategies(forkMenu(claude, "u1"))).toEqual({
      native: "该会话没有可用的精确 native Fork；请选择明确标识的原文重建或 Handoff。",
      "visible-history": undefined,
      handoff: undefined,
    });
    const unmapped = source();
    delete unmapped.blocks[0].nativeContext;
    expect(strategies(forkMenu(unmapped, "u1")).native).toMatch(/缺少当前 binding 的 native ID 映射/);
  });

  it("refuses visible history over its limit instead of trimming it", () => {
    const long = source();
    long.blocks[2] = { ...long.blocks[2], text: "x".repeat(FORK_VISIBLE_HISTORY_LIMIT) };
    expect(strategies(forkMenu(long, "u1"))["visible-history"]).toMatch(/超过 64000 上限/);
  });

  it("describes native inheritance by the saved provider, not the session's current harness", () => {
    const child = createForkChild({
      source: source(), endBlockId: "a1", childId: "child", requestId: "r", strategy: "native",
      native: { providerSessionId: "native_child", nativeCutoff: "inclusive-turn",
        nativeTurns: [{ harness: "codex", sessionId: "native_child", turnId: "t1", source: "fork" }] },
    });
    const inherited = child.blocks.find((block): block is Block => !!block.forkOrigin)!;
    // Switching the child's harness later does not rewrite who inherited what.
    child.harness = "claude";
    expect(forkInheritance(inherited.forkOrigin!, inherited)).toBe("Codex kept its native context through this turn.");
    expect(turnLabel(child.blocks, inherited.forkOrigin!.blocks.at(-1)?.childId)?.label).toBe("Turn 1 · First question");
  });
});
