import { expect, it, vi } from "vitest";
import { newSession, type Session } from "../model/session";
import { getSession, sanitizeSessionForPersist } from "./sessionStore";
import { cancelBtwThread } from "../model/btw";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it.each(["cancelled", "error"] as const)("persists and hydrates an ordinary/Fork child %s turn", async (turnOutcome) => {
  const session = newSession("codex", "/repo", "codex:gpt-6.1-sol");
  session.blocks = [
    { id: "u1", role: "user", text: "Cancelable child", startedAt: 1_000, durationMs: 28_000, turnOutcome,
      providerTurnId: "child-turn" },
    { id: "partial", role: "assistant", text: "PARTIAL-KEEP" },
    { id: "sleep", role: "tool", text: "sleep 60", tool: { callId: "sleep", status: turnOutcome === "error" ? "failed" : "cancelled" },
      approval: { requestId: 7, decided: "allow" } },
  ];
  const record = sanitizeSessionForPersist(session);
  invoke.mockImplementation(async (command: string) => command === "session_get" ? record : null);
  const restored = await getSession(session.id) as Session;
  expect(restored.blocks[0]).toMatchObject({ turnOutcome, durationMs: 28_000, providerTurnId: "child-turn" });
  expect(restored.blocks[1].text).toBe("PARTIAL-KEEP");
  expect(restored.blocks[2]).toMatchObject({ tool: { status: turnOutcome === "error" ? "failed" : "cancelled" }, approval: { decided: "allow" } });
  expect(restored.busy).toBe(false);
});

it.each(["queued", "running"] as const)("restores %s Btw as interrupted with its native ID, scope and selected sources", async (status) => {
  const session = newSession("codex", "/repo", "gpt-6.1-sol");
  session.blocks = [{ id: "u1", role: "user", text: "Before", durationMs: 1, inherited: true,
    nativeContext: { harness: "codex", sessionId: "child_native", turnId: "turn1", source: "fork" },
    forkOrigin: { sourceSessionId: "parent", sourceUserBlockId: "old_user", sourceEndBlockId: "old_end",
      strategy: "native", cutoff: "completed-turn-inclusive", nativeCutoff: "inclusive-turn", requestId: "req", createdAt: 1,
      blocks: [{ sourceId: "old_user", childId: "u1" }], warnings: [] },
    btwThreads: [{ id: "btw1", sourceEndBlockId: "a1", createdAt: 1, updatedAt: 2, status,
      providerThreadId: "saved_side", contextScope: "as-of a1; finite excerpts; read-only", readSources: [
        { sessionId: "selected", title: "Source", cwd: "/repo", harness: "pi" }],
      messages: [{ id: "q1", role: "user", text: "Question", createdAt: 1 }] }] },
  { id: "a1", role: "assistant", text: "Answer", inherited: true },
  { id: "plan", role: "plan", text: "Not executed", inherited: true, plan: { status: "ready" } }];
  session.providerSessionId = "child_native";
  const record = sanitizeSessionForPersist(session);
  invoke.mockImplementation(async (command: string) => command === "session_get" ? record : null);
  const restored = await getSession(session.id) as Session;
  const side = restored.blocks[0].btwThreads![0];
  expect(side.status).toBe("error"); expect(side.error).toContain("interrupted");
  expect(side.providerThreadId).toBe("saved_side"); expect(side.contextScope).toContain("as-of");
  expect(side.readSources?.map((source) => source.sessionId)).toEqual(["selected"]);
  expect(restored.blocks[0].nativeContext?.sessionId).toBe("child_native");
  expect(restored.blocks[0].forkOrigin?.sourceEndBlockId).toBe("old_end");
  expect(restored.blocks[2]).toMatchObject({ inherited: true, plan: { status: "ready" } });
  expect(restored.busy).toBe(false);
});

it("preserves an unconfirmed native cancellation notice on a cancelled discussion", async () => {
  const session = newSession("codex", "/repo", "gpt-6.1-sol");
  session.blocks = [{ id: "u1", role: "user", text: "Before", durationMs: 1,
    btwThreads: [{ id: "btw1", sourceEndBlockId: "a1", createdAt: 1, updatedAt: 10,
      status: "cancelled", error: "Codex side interrupt failed (side/turn): rejected", providerThreadId: "side",
      messages: [{ id: "q1", role: "user", text: "Question", createdAt: 1 }] }] },
    { id: "a1", role: "assistant", text: "Answer" }];
  const record = sanitizeSessionForPersist(session);
  invoke.mockImplementation(async (command: string) => command === "session_get" ? record : null);
  const restored = await getSession(session.id) as Session;
  expect(restored.blocks[0].btwThreads![0]).toMatchObject({ status: "cancelled", providerThreadId: "side",
    error: "Codex side interrupt failed (side/turn): rejected" });
});

it.each(["queued", "running"] as const)("saves and restores an explicitly cancelled %s Btw without treating it as completed or interrupted", async (status) => {
  const session = newSession("codex", "/repo", "gpt-6.1-sol");
  const side = cancelBtwThread({ id: "btw1", sourceEndBlockId: "a1", createdAt: 1, updatedAt: 2, status,
    harness: "codex", providerThreadId: "saved_side", contextScope: "as-of a1; read-only",
    readSources: [{ sessionId: "selected", title: "Source", cwd: "/repo", harness: "pi" }],
    messages: [{ id: "q1", role: "user", text: "Question", createdAt: 1 }],
    ...(status === "running" ? { pendingBlocks: [{ id: "part", role: "assistant", text: "Partial answer", streaming: true }] } : {}),
  }, 10);
  session.blocks = [{ id: "u1", role: "user", text: "Before", durationMs: 1, btwThreads: [side] },
    { id: "a1", role: "assistant", text: "Answer" }];
  const record = sanitizeSessionForPersist(session);
  expect(record.blocks[0].btwThreads![0].status).toBe("cancelled");
  invoke.mockImplementation(async (command: string) => command === "session_get" ? record : null);
  const restored = await getSession(session.id) as Session;
  const saved = restored.blocks[0].btwThreads![0];
  expect(saved.status).toBe("cancelled"); expect(saved.error).toBeUndefined();
  expect(saved.sourceEndBlockId).toBe("a1"); expect(saved.providerThreadId).toBe("saved_side");
  expect(saved.contextScope).toBe(side.contextScope); expect(saved.readSources).toEqual(side.readSources);
  expect(saved.messages).toEqual(record.blocks[0].btwThreads![0].messages);
  expect(saved.messages).toHaveLength(status === "running" ? 2 : 1);
  if (status === "running") expect(saved.messages.at(-1)?.text).toBe("Partial answer");
  expect(restored.busy).toBe(false);
});
