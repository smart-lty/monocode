// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let checkpoint: typeof import("./checkpoint");
beforeEach(async () => {
  vi.resetModules();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  checkpoint = await import("./checkpoint");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("waits for the baseline before begin resolves and for cancellation before capture", async () => {
  const baseline = deferred();
  const stopped = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "session_checkpoint_begin_turn") await baseline.promise;
    return undefined;
  });
  let ready = false;
  const begin = checkpoint.beginSessionTurn("s", "/repo").then((id) => {
    ready = true;
    return id;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  baseline.resolve();
  const turnId = await begin;
  const finish = checkpoint.finishSessionTurn("s", "/repo", {
    turnId,
    after: stopped.promise,
  });
  const status = checkpoint.sessionCheckpointStatus("s", "/repo");
  await Promise.resolve();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "session_checkpoint_begin_turn",
  ]);
  stopped.resolve();
  await Promise.all([finish, status]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "session_checkpoint_begin_turn",
    "session_checkpoint_finish_turn",
    "session_checkpoint_status",
  ]);
  expect(invoke).toHaveBeenCalledWith("session_checkpoint_finish_turn", {
    sessionId: "s",
    cwd: "/repo",
    turnId,
  });
});

it("an old completion cannot clear the newer turn's active token", async () => {
  const first = await checkpoint.beginSessionTurn("s", "/repo");
  const second = await checkpoint.beginSessionTurn("s", "/repo");
  await checkpoint.finishSessionTurn("s", "/repo", { turnId: first });
  await checkpoint.finishSessionTurn("s", "/repo");
  expect(invoke).toHaveBeenLastCalledWith("session_checkpoint_finish_turn", {
    sessionId: "s",
    cwd: "/repo",
    turnId: second,
  });
  expect(second).not.toBe(first);
});

it("does not capture a workspace when no local turn was started", async () => {
  await checkpoint.finishSessionTurn("s", "/repo");
  expect(invoke).not.toHaveBeenCalled();
});

it("queues the immutable new worker baseline before its first execution and preserves retained mode", async () => {
  const baseline = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "session_checkpoint_ensure") await baseline.promise;
    return undefined;
  });
  const ensure = checkpoint.ensureSessionCheckpoint("worker", "/isolated", { worker: true });
  const turn = checkpoint.beginSessionTurn("worker", "/isolated", { required: true });
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("session_checkpoint_ensure", { sessionId: "worker", cwd: "/isolated", worker: true });
  baseline.resolve();
  await Promise.all([ensure, turn]);
  await checkpoint.ensureSessionCheckpoint("worker", "/isolated", { worker: false });
  expect(invoke).toHaveBeenLastCalledWith("session_checkpoint_ensure", { sessionId: "worker", cwd: "/isolated", worker: false });
});

it("propagates required worker baseline and result capture failures", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("No baseline"));
  await expect(checkpoint.beginSessionTurn("worker", "/isolated", { required: true })).rejects.toThrow("No baseline");
  vi.mocked(invoke).mockResolvedValue(undefined);
  const turnId = await checkpoint.beginSessionTurn("worker", "/isolated", { required: true });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Result was not durable"));
  await expect(checkpoint.finishSessionTurn("worker", "/isolated", { turnId, required: true })).rejects.toThrow("not durable");
});

it("recovers only an already saved turn after stopping, without initializing a replacement baseline", async () => {
  const stopped = deferred();
  const finish = checkpoint.finishSessionTurn("worker", "/isolated", {
    recover: true, required: true, after: stopped.promise,
  });
  const apply = checkpoint.applySessionCheckpoint("worker", "/isolated", "/lead", ["src"]);
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
  stopped.resolve();
  await Promise.all([finish, apply]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "session_checkpoint_finish_turn", "session_checkpoint_apply",
  ]);
  expect(invoke).toHaveBeenCalledWith("session_checkpoint_finish_turn", {
    sessionId: "worker", cwd: "/isolated", turnId: null,
  });
  expect(invoke).toHaveBeenCalledWith("session_checkpoint_apply", {
    sessionId: "worker", fromCwd: "/isolated", toCwd: "/lead", files: ["src"],
  });
});
