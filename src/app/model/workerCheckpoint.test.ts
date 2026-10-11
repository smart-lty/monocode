import { beforeEach, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import { finishSessionTurn } from "../../features/sessions/model/checkpoint";
import { finishStoppedWorkerCheckpoint } from "./workerCheckpoint";

vi.mock("../../features/sessions/model/checkpoint", () => ({ finishSessionTurn: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

it("does not infer worker identity from an absent run, session or lead checkpoint", async () => {
  const ordinary = { ...newSession("codex", "/repo"), id: "ordinary" };
  const lead = { ...ordinary, id: "lead" };
  await finishStoppedWorkerCheckpoint(ordinary.id, ordinary);
  await finishStoppedWorkerCheckpoint(lead.id, lead);
  await finishStoppedWorkerCheckpoint("unloaded");
  await finishStoppedWorkerCheckpoint(lead.id, { ...lead, orchestrationLeadId: lead.id });
  expect(finishSessionTurn).not.toHaveBeenCalled();
});

it("uses saved worker ownership or explicit restore identity before the run is committed", async () => {
  const worker = { ...newSession("codex", "/repo"), id: "worker", orchestrationLeadId: "lead", worktreeCwd: "/isolated" };
  await finishStoppedWorkerCheckpoint(worker.id, worker);
  await finishStoppedWorkerCheckpoint("unloaded-worker", undefined, { cwd: "/retained" });
  expect(finishSessionTurn).toHaveBeenCalledWith("worker", "/isolated", { recover: true, required: true });
  expect(finishSessionTurn).toHaveBeenCalledWith("unloaded-worker", "/retained", { recover: true, required: true });
});
