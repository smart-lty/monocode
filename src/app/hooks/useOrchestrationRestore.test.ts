// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import { Orchestrator, type OrchestrationRun } from "../../features/orchestration/model/orchestration";
import { useOrchestrationRestore } from "./useOrchestrationRestore";

const state = vi.hoisted(() => ({ manager: null as Orchestrator | null }));
vi.mock("../../features/orchestration/model/orchestration", async (original) => ({
  ...(await original<typeof import("../../features/orchestration/model/orchestration")>()),
  orchestrator: { hydrate: (id: string) => state.manager!.hydrate(id) },
}));
afterEach(() => vi.unstubAllGlobals());

it.each(["active", "paused", "stopped", "finished"] as const)(
  "restores a saved %s run without any pane or historical card and loads it once",
  async (status) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const lead = { ...newSession("codex", "/repo"), id: "lead" };
    const run: OrchestrationRun = {
      version: 2, leadId: lead.id, cwd: lead.cwd, status,
      allowedHarnesses: ["codex"], maxWorkers: 1, cli: "monocode",
      tasks: [], requests: {}, continuations: 0,
    };
    const store = {
      load: vi.fn(async () => run), save: vi.fn(async () => {}),
      enable: vi.fn(async () => "monocode"), disable: vi.fn(async () => {}),
      scopes: vi.fn(async () => []), resolvePath: vi.fn(async (path: string) => path),
    };
    const host = {
      session: () => lead, sessions: () => [lead], choices: () => [],
      createWorker: vi.fn(), integrateWorker: vi.fn(), cleanupWorker: vi.fn(),
      submit: vi.fn(), stop: vi.fn(async () => {}), steer: vi.fn(),
      respondApproval: vi.fn(), answerQuestion: vi.fn(),
    };
    const manager = new Orchestrator(store);
    manager.bind(host);
    state.manager = manager;
    const remote = () => false;
    function LoadedSession() {
      useOrchestrationRestore([lead, { ...lead, id: "worker", orchestrationLeadId: lead.id }], remote);
      return createElement("div", null, "Session loaded; transcript not mounted");
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(LoadedSession)));
      await vi.waitFor(() => expect(manager.run(lead.id)?.status).toBe(status === "active" ? "paused" : status));
      await act(async () => root.render(createElement(LoadedSession)));
      expect(store.load).toHaveBeenCalledExactlyOnceWith(lead.id);
      expect(store.disable).toHaveBeenCalledWith(lead.id);
      expect(host.submit).not.toHaveBeenCalled();
      expect(store.enable).not.toHaveBeenCalled();
      expect(container.textContent).toContain("transcript not mounted");
    } finally {
      act(() => root.unmount());
    }
  },
);
