import { expect, it, vi } from "vitest";
import { runSessionFork } from "./sessionForkOperation";
import { newSession, type Session } from "./session";
import { agentAppSourceAllowed } from "../../agent-app/model/agentApp";
import { sanitizeSessionForPersist } from "../data/sessionStore";
import { UnboundForkError, type ForkSessionResult } from "../../../integrations/harness/core/types";

function fixture() {
  const initial = newSession("codex", "/repo", "gpt-6.1-sol", "full-access");
  initial.id = "source"; initial.providerSessionId = "parent";
  initial.blocks = [{ id: "u1", role: "user", text: "BEFORE", durationMs: 1,
    attachments: [{ id: "file", name: "old.txt", kind: "file", mimeType: "text/plain", size: 1, path: "/old.txt" }],
    nativeContext: { harness: "codex", sessionId: "parent", turnId: "t1", source: "provider" } },
  { id: "a1", role: "assistant", text: "answer" }];
  const state = { current: initial as Session | undefined, status: "finished" };
  const discard = vi.fn(async () => undefined);
  const native: ForkSessionResult = { providerSessionId: "child_native", nativeCutoff: "inclusive-turn",
    nativeTurns: [{ harness: "codex", sessionId: "child_native", turnId: "t1", source: "fork" }], discard };
  const host = {
    source: () => {
      if (state.current && !agentAppSourceAllowed(state.current, { status: state.status })) throw new Error("live lead/worker");
      return state.current;
    },
    available: vi.fn(async () => true), fork: vi.fn(async () => native),
    save: vi.fn(async (_session: Session) => undefined), remove: vi.fn(async (_id: string) => undefined),
    publish: vi.fn((_child: Session, _source: Session) => undefined),
  };
  return { state, native, host, discard, initial,
    request: { sourceSessionId: "source", sourceEndBlockId: "a1", requestId: "req" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each(["stopped", "finished"])("allows a historical %s lead through the existing eligibility semantics", async (status) => {
  const f = fixture(); f.state.status = status;
  await expect(runSessionFork(f.request, f.host)).resolves.toBeTruthy();
  expect(f.host.publish).toHaveBeenCalledTimes(1);
});
it.each(["active", "paused"])("keeps %s lead and workers blocked", async (status) => {
  const f = fixture(); f.state.status = status;
  await expect(runSessionFork(f.request, f.host)).rejects.toThrow("live lead");
  f.state.status = "finished"; f.initial.orchestrationLeadId = "lead";
  await expect(runSessionFork(f.request, f.host)).rejects.toThrow("worker");
  expect(f.host.fork).not.toHaveBeenCalled();
});
it.each(["edit", "remove", "binding"])("revalidates %s during delayed attachment inspection before creating native child", async (change) => {
  const f = fixture(), wait = deferred<boolean>();
  f.host.available.mockImplementation(() => wait.promise);
  const pending = runSessionFork(f.request, f.host);
  const rejected = expect(pending).rejects.toThrow(/来源已删除|内容或 binding 已变化/);
  if (change === "edit") f.initial.blocks[0].text = "EDITED";
  else if (change === "binding") f.initial.providerSessionId = "replacement";
  else f.state.current = undefined;
  wait.resolve(true); await rejected;
  expect(f.host.fork).not.toHaveBeenCalled(); expect(f.host.save).not.toHaveBeenCalled();
  expect(f.host.publish).not.toHaveBeenCalled(); expect(f.discard).not.toHaveBeenCalled();
});
it.each(["edit", "remove", "binding"])("discards an unbound native child after source %s during delayed provider response", async (change) => {
  const f = fixture(), wait = deferred<ForkSessionResult>();
  f.host.fork.mockImplementation(() => wait.promise);
  const pending = runSessionFork(f.request, f.host);
  const rejected = expect(pending).rejects.toThrow(/来源已删除|内容或 binding 已变化/);
  await vi.waitFor(() => expect(f.host.fork).toHaveBeenCalledTimes(1));
  if (change === "edit") f.initial.blocks[1].text = "EDITED";
  else if (change === "binding") f.initial.providerSessionId = "replacement";
  else f.state.current = undefined;
  wait.resolve(f.native); await rejected;
  expect(f.discard).toHaveBeenCalledTimes(1); expect(f.host.save).not.toHaveBeenCalled();
  expect(f.host.publish).not.toHaveBeenCalled();
});
it("permits only future-turn appends and keeps copied content at the original cutoff", async () => {
  const f = fixture(), wait = deferred<ForkSessionResult>();
  f.host.fork.mockImplementation(() => wait.promise);
  const pending = runSessionFork(f.request, f.host);
  await vi.waitFor(() => expect(f.host.fork).toHaveBeenCalledTimes(1));
  f.initial.busy = true;
  f.initial.blocks.push({ id: "u2", role: "user", text: "AFTER_UNIQUE", durationMs: 2 }, { id: "a2", role: "assistant", text: "after" },
    { id: "u3", role: "user", text: "RUNNING", streaming: true });
  const before = JSON.stringify(f.initial);
  wait.resolve(f.native); await pending;
  const saved = f.host.save.mock.calls[0][0];
  expect(JSON.stringify(saved)).not.toContain("AFTER_UNIQUE"); expect(JSON.stringify(saved)).not.toContain("RUNNING");
  expect(JSON.stringify(f.initial)).toBe(before); expect(f.discard).not.toHaveBeenCalled();
});
it("revalidates again after save and removes the unpublished application child", async () => {
  const f = fixture(), wait = deferred<void>();
  f.host.save.mockImplementation(() => wait.promise);
  const pending = runSessionFork(f.request, f.host);
  const rejected = expect(pending).rejects.toThrow("来源已删除");
  await vi.waitFor(() => expect(f.host.save).toHaveBeenCalledTimes(1));
  f.state.current = undefined; wait.resolve(); await rejected;
  expect(f.host.remove).toHaveBeenCalledWith(f.host.save.mock.calls[0][0].id, "codex");
  expect(f.discard).toHaveBeenCalledTimes(1); expect(f.host.publish).not.toHaveBeenCalled();
});
it("persists explicit recoverable native ID if cleanup fails, without assigning a native binding", async () => {
  const f = fixture();
  f.host.fork.mockImplementation(async () => { f.state.current = undefined; return f.native; });
  f.discard.mockRejectedValue(new Error("offline"));
  await expect(runSessionFork(f.request, f.host)).rejects.toThrow("child_native");
  const recovery = sanitizeSessionForPersist(f.host.save.mock.calls[0][0]);
  expect(recovery.providerSessionId).toBeUndefined(); expect(recovery.blocks[0].forkOrigin?.recovery)
    .toMatchObject({ unboundNativeSessionId: "child_native" });
  expect(f.host.publish).not.toHaveBeenCalled();
});
it("also records an adapter cleanup failure that occurs before it can return a result", async () => {
  const f = fixture(); f.host.fork.mockRejectedValue(new UnboundForkError("failed archive", "orphan_native"));
  await expect(runSessionFork(f.request, f.host)).rejects.toThrow("orphan_native");
  expect(f.host.save.mock.calls[0][0].blocks[0].forkOrigin?.recovery?.unboundNativeSessionId).toBe("orphan_native");
  expect(f.host.publish).not.toHaveBeenCalled();
});
